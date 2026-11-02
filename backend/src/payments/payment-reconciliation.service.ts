import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, isNotNull, lt, lte, or } from 'drizzle-orm';
import { db } from '../db/database.js';
import { appointment, payment, refund } from '../db/schema.js';
import { RAZORPAY_TOKEN, type RazorpayInstance } from './razorpay.provider.js';
import { PaymentsService } from './payments.service.js';

interface RazorpayPaymentLedger {
  id: string;
  order_id?: string;
  amount: number | string;
  currency: string;
  status: string;
  amount_refunded?: number;
  refund_status?: string | null;
}

interface RazorpayRefundItem {
  id: string;
  amount?: number;
  currency?: string;
  payment_id?: string;
  status?: string;
  receipt?: string;
  acquirer_data?: { arn?: string };
  notes?: Record<string, unknown>;
}

interface RazorpayRefundCollection {
  entity?: string;
  count?: number;
  items?: RazorpayRefundItem[];
}

interface PaymentsWithFetchMultipleRefund {
  fetchMultipleRefund(
    paymentId: string,
    params?: { count?: number; skip?: number; from?: number; to?: number },
  ): Promise<RazorpayRefundCollection | RazorpayRefundItem[]>;
}

interface RefundsWithAll {
  all(params?: {
    payment_id?: string;
    count?: number;
    skip?: number;
    from?: number;
    to?: number;
  }): Promise<RazorpayRefundCollection | RazorpayRefundItem[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasFetchMultipleRefund(
  payments: unknown,
): payments is PaymentsWithFetchMultipleRefund {
  return isRecord(payments) && typeof payments.fetchMultipleRefund === 'function';
}

function hasRefundsAll(
  refunds: unknown,
): refunds is RefundsWithAll {
  return isRecord(refunds) && typeof refunds.all === 'function';
}

function isRazorpayPaymentLedger(
  value: unknown,
): value is RazorpayPaymentLedger {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.id !== 'string') {
    return false;
  }
  const hasValidAmountRefunded =
    value.amount_refunded === undefined || typeof value.amount_refunded === 'number';
  const hasValidRefundStatus =
    value.refund_status === undefined ||
    value.refund_status === null ||
    typeof value.refund_status === 'string';

  return hasValidAmountRefunded && hasValidRefundStatus;
}

@Injectable()
export class PaymentReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    @Inject(RAZORPAY_TOKEN)
    private readonly razorpay: RazorpayInstance,
  ) {}

  async onModuleInit() {
    // Run an initial sweep on server startup
    try {
      await this.reconcileInconsistentPayments();
    } catch (err) {
      this.logger.error('Startup payment reconciliation failed:', err);
    }
  }

  /**
   * Periodic reconciliation job running every 60 seconds.
   */
  @Interval(60_000)
  async handleCron() {
    try {
      const reconciledCount = await this.reconcileInconsistentPayments();
      if (reconciledCount > 0) {
        this.logger.log(`Successfully reconciled ${reconciledCount} payment(s)/refund(s).`);
      }
    } catch (err) {
      this.logger.error('Error during scheduled payment reconciliation:', err);
    }
  }

  /**
   * Sweeps the database for inconsistent payment states and stale pending refunds:
   * 1. Captured payments for cancelled appointments that are not yet refunded.
   * 2. Pending refunds older than 5 minutes that might have completed or failed on Razorpay.
   */
  async reconcileInconsistentPayments(now = new Date()): Promise<number> {
    let reconciledCount = 0;

    // --- Sweep 1: Captured payments on cancelled appointments ---
    const unreconciledPayments = await db
      .select({
        paymentId: payment.id,
        amountPaise: payment.amountPaise,
        refundedAmountPaise: payment.refundedAmountPaise,
        appointmentId: appointment.id,
      })
      .from(payment)
      .innerJoin(appointment, eq(payment.appointmentId, appointment.id))
      .where(
        and(
          eq(payment.status, 'captured'),
          eq(appointment.status, 'cancelled'),
          lt(payment.refundedAmountPaise, payment.amountPaise),
        ),
      )
      .limit(20);

    for (const record of unreconciledPayments) {
      // Check if there is an active pending refund
      const [pendingRefund] = await db
        .select({ id: refund.id })
        .from(refund)
        .where(and(eq(refund.paymentId, record.paymentId), eq(refund.status, 'pending')))
        .limit(1);

      if (pendingRefund) {
        continue;
      }

      try {
        await this.paymentsService.refundPayment(
          'SYSTEM_RECONCILIATION',
          'system',
          record.paymentId,
          {
            reason: 'Automated reconciliation: appointment cancelled while payment was captured',
          },
        );
        reconciledCount++;
      } catch (err) {
        this.logger.error(
          `Failed to reconcile captured payment ${record.paymentId} for cancelled appointment:`,
          err,
        );
      }
    }

    // --- Sweep 2: Active & stale pending refunds ---
    // 1. Pending refunds with a Razorpay ID can be reconciled immediately.
    // 2. Ambiguous refunds (without Razorpay ID) wait for 5 minutes before querying collections.
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const pendingRefunds = await db
      .select({
        id: refund.id,
        paymentId: refund.paymentId,
        razorpayRefundId: refund.razorpayRefundId,
        amountPaise: refund.amountPaise,
      })
      .from(refund)
      .where(
        and(
          eq(refund.status, 'pending'),
          or(isNotNull(refund.razorpayRefundId), lte(refund.createdAt, fiveMinutesAgo)),
        ),
      )
      .limit(20);

    for (const stRefund of pendingRefunds) {
      const reconciled = await this.reconcilePendingRefund(stRefund);
      if (reconciled) {
        reconciledCount++;
      }
    }

    return reconciledCount;
  }

  /**
   * Reconciles a single pending refund record against Razorpay.
   * Returns true if the refund was transitioned to a terminal state ('processed' or 'failed').
   */
  async reconcilePendingRefund(stRefund: {
    id: string;
    paymentId: string;
    razorpayRefundId: string | null;
    amountPaise: number;
  }): Promise<boolean> {
    try {
      let rzpRefundId = stRefund.razorpayRefundId;
      let rzpStatus: { status: string; acquirer_data?: { arn?: string }; id?: string } | null = null;

      if (rzpRefundId) {
        rzpStatus = await this.razorpay.refunds.fetch(rzpRefundId);
      } else {
        // Ambiguous refund that timed out before receiving Razorpay ID:
        // Query Razorpay payments endpoint to verify if the refund was actually created remotely
        const [payRecord] = await db
          .select({
            id: payment.id,
            razorpayPaymentId: payment.razorpayPaymentId,
          })
          .from(payment)
          .where(eq(payment.id, stRefund.paymentId))
          .limit(1);

        if (!payRecord?.razorpayPaymentId) {
          return false;
        }

        // 1. Fetch remote payment ledger state to verify overall refund status
        let rzpPayment: RazorpayPaymentLedger | null = null;
        try {
          const fetched = await this.razorpay.payments.fetch(payRecord.razorpayPaymentId);
          if (isRazorpayPaymentLedger(fetched)) {
            rzpPayment = fetched;
          }
        } catch (fetchErr) {
          this.logger.warn(
            `Failed to fetch payment ledger for ${payRecord.razorpayPaymentId} during refund reconciliation:`,
            fetchErr,
          );
          return false;
        }

        // 2. Fetch refund collection with count: 100 to avoid pagination truncation
        let refundItems: RazorpayRefundItem[] = [];
        if (hasFetchMultipleRefund(this.razorpay.payments)) {
          const res = await this.razorpay.payments.fetchMultipleRefund(payRecord.razorpayPaymentId, {
            count: 100,
          });
          refundItems = Array.isArray(res) ? res : (res?.items ?? []);
        } else if (hasRefundsAll(this.razorpay.refunds)) {
          const res = await this.razorpay.refunds.all({
            payment_id: payRecord.razorpayPaymentId,
            count: 100,
          });
          refundItems = Array.isArray(res) ? res : (res?.items ?? []);
        }

        const expectedReceipt = `rf_${stRefund.id.replace(/-/g, '').slice(0, 20)}`;
        const matched = refundItems.find((item: RazorpayRefundItem) => {
          const notes = isRecord(item.notes) ? item.notes : undefined;
          const directRefundId = notes ? notes.refundId : undefined;
          const nestedNotes = notes && isRecord(notes.notes) ? notes.notes : undefined;
          const nestedRefundId = nestedNotes ? nestedNotes.refundId : undefined;

          return (
            directRefundId === stRefund.id ||
            item.receipt === expectedReceipt ||
            nestedRefundId === stRefund.id
          );
        });

        if (matched) {
          // Discovered the remote refund created during the timed-out attempt!
          rzpRefundId = matched.id;
          rzpStatus = {
            id: matched.id,
            status: matched.status ?? 'pending',
            acquirer_data: matched.acquirer_data,
          };
        } else {
          // No matching refund found in collection.
          // Check if the payment ledger shows any refunded amount
          const hasRemoteRefunds =
            (rzpPayment?.amount_refunded ?? 0) > 0 ||
            (rzpPayment?.refund_status !== null && rzpPayment?.refund_status !== undefined);

          if (hasRemoteRefunds) {
            // Ledger shows refund occurred, but no item matched our specific attempt!
            // Per policy: amount_refunded > 0 alone does NOT prove this attempt succeeded.
            // Retain pending and emit an operator warning for manual audit.
            this.logger.warn(
              `Payment ${payRecord.razorpayPaymentId} shows refunded amount (${rzpPayment?.amount_refunded} paise), but no remote refund matches uncertain local refund ${stRefund.id} (receipt: ${expectedReceipt}). Keeping pending for operator audit.`,
            );
            await db
              .update(refund)
              .set({
                failureReason: `GATEWAY_AUDIT_WARNING: Ledger shows refunded balance (${rzpPayment?.amount_refunded} paise), but no refund item matched receipt ${expectedReceipt}. Retained pending for operator review.`,
                updatedAt: new Date(),
              })
              .where(eq(refund.id, stRefund.id));
          } else {
            // Ledger shows 0 refunded, but absence from one API response does NOT prove the request was never created.
            // NEVER mark failed merely because absent from one response. Retain pending to prevent duplicate retries.
            this.logger.log(
              `Refund attempt ${stRefund.id} (payment: ${payRecord.razorpayPaymentId}) not found in gateway list. Retaining pending state (no duplicate refund will be issued).`,
            );
            await db
              .update(refund)
              .set({
                failureReason: `AWAITING_GATEWAY_RECONCILIATION: Attempt ${stRefund.id} not visible in gateway refund collection yet. Retained pending to prevent duplicates.`,
                updatedAt: new Date(),
              })
              .where(eq(refund.id, stRefund.id));
          }
          return false;
        }
      }

      if (rzpStatus?.status === 'processed') {
        await db.transaction(async (tx) => {
          await tx
            .update(refund)
            .set({
              razorpayRefundId: rzpRefundId,
              status: 'processed',
              arn: rzpStatus?.acquirer_data?.arn ?? null,
              failureReason: null,
              updatedAt: new Date(),
            })
            .where(eq(refund.id, stRefund.id));

          const [payRecord] = await tx
            .select()
            .from(payment)
            .where(eq(payment.id, stRefund.paymentId))
            .for('update')
            .limit(1);

          if (payRecord) {
            const newRefundedPaise = (payRecord.refundedAmountPaise ?? 0) + stRefund.amountPaise;
            const isFullyRefunded = newRefundedPaise >= payRecord.amountPaise;
            await tx
              .update(payment)
              .set({
                refundedAmountPaise: newRefundedPaise,
                status: isFullyRefunded ? 'refunded' : payRecord.status,
                updatedAt: new Date(),
              })
              .where(eq(payment.id, payRecord.id));
          }
        });
        return true;
      } else if (rzpStatus?.status === 'failed') {
        await db
          .update(refund)
          .set({
            razorpayRefundId: rzpRefundId,
            status: 'failed',
            failureReason: 'Refund marked failed by Razorpay settlement gateway',
            updatedAt: new Date(),
          })
          .where(eq(refund.id, stRefund.id));
        return true;
      } else if (rzpStatus?.status === 'pending' && rzpRefundId && !stRefund.razorpayRefundId) {
        // Attached remote ID to pending refund for next sweep
        await db
          .update(refund)
          .set({
            razorpayRefundId: rzpRefundId,
            updatedAt: new Date(),
          })
          .where(eq(refund.id, stRefund.id));
      }
    } catch (err) {
      this.logger.error(`Failed to reconcile pending refund ${stRefund.id}:`, err);
    }
    return false;
  }
}
