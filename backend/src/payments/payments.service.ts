import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/database.js';
import { appointment, doctorAvailability, doctorProfile, doctorScheduleOverride, payment, refund, user } from '../db/schema.js';
import { loadEnv, type AppEnvironment } from '../config/env.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EmailOutboxService, emailEventKey, type OutboxTransaction } from '../notifications/email-outbox.service.js';
import { AppointmentReminderService } from '../notifications/appointment-reminder.service.js';
import { DoctorScheduleService } from '../doctors/doctor-schedule.service.js';
import { reserveWithinCapacity } from '../appointments/appointment-conflict.js';
import { RAZORPAY_TOKEN, type RazorpayInstance } from './razorpay.provider.js';
import type {
  AdminListPaymentsQueryDto,
  AdminListRefundsQueryDto,
  CreatePaymentOrderDto,
  CreateRefundDto,
  VerifyPaymentDto,
} from './payments.schema.js';

type PaymentsTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly env: AppEnvironment;

  constructor(
    @Inject(RAZORPAY_TOKEN)
    private readonly razorpay: RazorpayInstance,
    @Optional()
    private readonly notifications?: NotificationsService,
    @Optional()
    private readonly emailOutbox?: EmailOutboxService,
    @Optional()
    private readonly scheduleService?: DoctorScheduleService,
    @Optional()
    private readonly appointmentReminders?: AppointmentReminderService,
  ) {
    this.env = loadEnv();
  }

  private async scheduleAppointmentReminders(
    tx: OutboxTransaction,
    record: { id: string; patientId: string; doctorId: string; startsAt: Date; updatedAt: Date; reminderGeneration: number },
  ): Promise<void> {
    if (!this.appointmentReminders) return;
    const timezone = await this.scheduleService?.getTimezoneForDoctor(record.doctorId) ?? 'Asia/Kolkata';
    await this.appointmentReminders.scheduleForAppointment(tx, record, timezone);
  }

  private async lockDoctorCapacity(tx: PaymentsTransaction, doctorId: string): Promise<void> {
    await tx.select({ id: doctorProfile.id }).from(doctorProfile)
      .where(eq(doctorProfile.userId, doctorId)).for('update').limit(1);
  }

  /**
   * A cancelled, expired hold no longer consumes capacity. Reacquire the same
   * doctor row lock as booking before deciding whether a late payment can revive it.
   */
  private async hasCapacityForLateCapture(
    tx: PaymentsTransaction,
    target: { id: string; doctorId: string; startsAt: Date; endsAt: Date },
  ): Promise<boolean> {
    try {
      await reserveWithinCapacity(
        () => this.lockDoctorCapacity(tx, target.doctorId),
        async () => {
          const timezone = await this.scheduleService?.getTimezoneForDoctor(target.doctorId) ?? 'Asia/Kolkata';
          const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(target.startsAt);
          const [weekly] = await tx.select({ capacity: doctorAvailability.capacity }).from(doctorAvailability)
            .where(eq(doctorAvailability.doctorId, target.doctorId)).limit(1);
          const [override] = await tx.select({ capacity: doctorScheduleOverride.capacity }).from(doctorScheduleOverride)
            .where(and(
              eq(doctorScheduleOverride.doctorId, target.doctorId),
              eq(doctorScheduleOverride.date, localDate),
            )).limit(1);
          return override?.capacity ?? weekly?.capacity ?? 1;
        },
        async () => {
          const now = new Date();
          return (await tx.select({ id: appointment.id }).from(appointment).where(and(
            eq(appointment.doctorId, target.doctorId),
            ne(appointment.id, target.id),
            or(
              eq(appointment.status, 'scheduled'),
              and(eq(appointment.status, 'pending_payment'), gt(appointment.holdExpiresAt, now)),
            ),
            lt(appointment.startsAt, target.endsAt),
            gt(appointment.endsAt, target.startsAt),
          ))).length;
        },
        async () => undefined,
      );
      return true;
    } catch (error) {
      if (error instanceof ConflictException) return false;
      throw error;
    }
  }

  private async enqueuePaymentConfirmationEmails(
    tx: OutboxTransaction,
    input: { appointmentId: string; paymentId: string; patientId: string; doctorId: string; startsAt: Date; amountPaise: number; currency: string },
  ): Promise<void> {
    if (!this.emailOutbox) return;
    const participants = await tx.select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, [input.patientId, input.doctorId]));
    const patient = participants.find((participant) => participant.id === input.patientId);
    const doctor = participants.find((participant) => participant.id === input.doctorId);
    if (!patient || !doctor) return;
    const timezone = await this.scheduleService?.getTimezoneForDoctor(input.doctorId);

    await this.emailOutbox.enqueue(tx, {
      eventKey: emailEventKey.booking(input.appointmentId, patient.id),
      eventType: 'booking_confirmation',
      recipient: patient.email,
      appointmentId: input.appointmentId,
      paymentId: input.paymentId,
      payload: {
        recipientName: patient.name,
        otherPartyName: `Dr. ${doctor.name}`,
        ...(timezone ? { startsAt: input.startsAt.toISOString(), timezone } : {}),
      },
    });
    await this.enqueuePaymentReceiptEmail(tx, input, patient, doctor, timezone);
    await this.emailOutbox.enqueue(tx, {
      eventKey: emailEventKey.booking(input.appointmentId, doctor.id),
      eventType: 'booking_confirmation',
      recipient: doctor.email,
      appointmentId: input.appointmentId,
      paymentId: input.paymentId,
      payload: {
        recipientName: doctor.name,
        otherPartyName: patient.name,
        ...(timezone ? { startsAt: input.startsAt.toISOString(), timezone } : {}),
      },
    });
  }

  private async enqueuePaymentReceiptEmail(
    tx: OutboxTransaction,
    input: { appointmentId: string; paymentId: string; patientId: string; doctorId: string; startsAt: Date; amountPaise: number; currency: string },
    knownPatient?: { id: string; name: string; email: string },
    knownDoctor?: { id: string; name: string; email: string },
    knownTimezone?: string,
  ): Promise<void> {
    if (!this.emailOutbox) return;
    let patient = knownPatient;
    let doctor = knownDoctor;
    if (!patient || !doctor) {
      const participants = await tx.select({ id: user.id, name: user.name, email: user.email })
        .from(user)
        .where(inArray(user.id, [input.patientId, input.doctorId]));
      patient = participants.find((participant) => participant.id === input.patientId);
      doctor = participants.find((participant) => participant.id === input.doctorId);
    }
    if (!patient || !doctor) return;
    const timezone = knownTimezone ?? await this.scheduleService?.getTimezoneForDoctor(input.doctorId);
    await this.emailOutbox.enqueue(tx, {
      eventKey: emailEventKey.receipt(input.paymentId, patient.id),
      eventType: 'payment_receipt',
      recipient: patient.email,
      appointmentId: input.appointmentId,
      paymentId: input.paymentId,
      payload: {
        recipientName: patient.name,
        otherPartyName: `Dr. ${doctor.name}`,
        ...(timezone ? { startsAt: input.startsAt.toISOString(), timezone } : {}),
        amountPaise: input.amountPaise,
        currency: input.currency,
      },
    });
  }

  private async enqueueRefundProcessedEmail(
    tx: OutboxTransaction,
    item: { id: string; patientId: string; appointmentId: string; paymentId: string; amountPaise: number; currency: string },
    arn: string | null,
  ): Promise<void> {
    if (!this.emailOutbox) return;
    const [patient] = await tx.select({ name: user.name, email: user.email })
      .from(user).where(eq(user.id, item.patientId)).limit(1);
    if (!patient) return;
    await this.emailOutbox.enqueue(tx, {
      eventKey: emailEventKey.refundProcessed(item.id, item.patientId),
      eventType: 'refund_processed',
      recipient: patient.email,
      appointmentId: item.appointmentId,
      paymentId: item.paymentId,
      refundId: item.id,
      payload: {
        recipientName: patient.name,
        amountPaise: item.amountPaise,
        currency: item.currency,
        arn,
      },
    });
  }

  /**
   * Generates a server-side Razorpay Order for an appointment held in `pending_payment` state.
   */
  async createOrder(patientId: string, input: CreatePaymentOrderDto) {
    const [record] = await db
      .select({
        id: appointment.id,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
        holdExpiresAt: appointment.holdExpiresAt,
      })
      .from(appointment)
      .where(eq(appointment.id, input.appointmentId))
      .limit(1);

    if (!record) {
      throw new NotFoundException('Appointment not found.');
    }

    if (record.patientId !== patientId) {
      throw new ForbiddenException('You are not authorized to pay for this appointment.');
    }

    if (record.status === 'scheduled') {
      throw new ConflictException('Appointment is already scheduled.');
    }

    if (record.status === 'cancelled') {
      throw new BadRequestException('Appointment is cancelled.');
    }

    if (record.status !== 'pending_payment') {
      throw new BadRequestException('Appointment is not awaiting payment.');
    }

    // Verify hold expiry
    if (record.holdExpiresAt && record.holdExpiresAt.getTime() <= Date.now()) {
      // Auto-cancel expired appointment to release slot lock
      await db
        .update(appointment)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(appointment.id, record.id));
      throw new BadRequestException('The booking hold for this slot has expired. Please select a new slot.');
    }

    // Query doctor consultation fee server-side
    const [doctor] = await db
      .select({
        consultationFeeInr: doctorProfile.consultationFeeInr,
      })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, record.doctorId))
      .limit(1);

    const feeInr = doctor?.consultationFeeInr ?? 0;
    if (!feeInr || feeInr <= 0) {
      throw new BadRequestException('Doctor consultation fee is not configured.');
    }

    const amountPaise = feeInr * 100;

    // Prevent duplicate orders: check existing payment record
    const [existingPayment] = await db
      .select()
      .from(payment)
      .where(eq(payment.appointmentId, record.id))
      .limit(1);

    if (existingPayment) {
      if (existingPayment.status === 'captured') {
        throw new ConflictException('Appointment has already been paid for.');
      }
      if (existingPayment.status === 'created') {
        // Idempotent: reuse existing active order
        return {
          orderId: existingPayment.razorpayOrderId,
          amountPaise: existingPayment.amountPaise,
          currency: existingPayment.currency,
          keyId: this.env.razorpayKeyId,
          appointmentId: record.id,
        };
      }
    }

    // Generate Razorpay Order
    const receipt = `rcpt_${record.id.replace(/-/g, '').slice(0, 20)}`;
    const rzpOrder = await this.razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        appointmentId: record.id,
        patientId: record.patientId,
        doctorId: record.doctorId,
      },
    });

    const paymentId = randomUUID();
    await db.insert(payment).values({
      id: paymentId,
      appointmentId: record.id,
      patientId: record.patientId,
      doctorId: record.doctorId,
      razorpayOrderId: rzpOrder.id,
      amountPaise,
      currency: 'INR',
      status: 'created',
      receipt,
      refundedAmountPaise: 0,
    });

    return {
      orderId: rzpOrder.id,
      amountPaise,
      currency: 'INR',
      keyId: this.env.razorpayKeyId,
      appointmentId: record.id,
    };
  }

  /**
   * Cryptographically verifies Razorpay payment signature and confirms appointment to `scheduled`.
   * Safely handles race conditions with hold expiration and slot reassignment.
   */
  async verifyPayment(patientId: string, input: VerifyPaymentDto) {
    // 1. Verify HMAC-SHA256 signature
    const isValidSignature = this.verifyHmacSignature(
      input.razorpayOrderId,
      input.razorpayPaymentId,
      input.razorpaySignature,
      this.env.razorpayKeySecret,
    );

    if (!isValidSignature) {
      throw new BadRequestException('Invalid payment signature.');
    }

    // 2. Fetch payment and appointment records inside transaction with consistent global row-level lock order: payment -> appointment
    const verificationResult = await db.transaction(async (tx) => {
      // Step 2a: Lock payment row FIRST
      const [paymentRecord] = await tx
        .select()
        .from(payment)
        .where(eq(payment.razorpayOrderId, input.razorpayOrderId))
        .for('update')
        .limit(1);

      if (!paymentRecord) {
        throw new NotFoundException('Payment order not found.');
      }

      if (paymentRecord.appointmentId !== input.appointmentId) {
        throw new BadRequestException('Payment order does not correspond to this appointment.');
      }

      if (paymentRecord.patientId !== patientId) {
        throw new ForbiddenException('You are not authorized to verify this payment.');
      }

      // Idempotency: if already captured, return success immediately
      if (paymentRecord.status === 'captured') {
        return {
          success: true,
          appointmentId: paymentRecord.appointmentId,
          paymentId: paymentRecord.id,
          status: 'captured',
          message: 'Payment has already been processed.',
        };
      }

      const isAllowedStatus =
        paymentRecord.status === 'created' ||
        (paymentRecord.status === 'failed' &&
          paymentRecord.failureReason?.toLowerCase().includes('expired'));

      if (!isAllowedStatus) {
        throw new BadRequestException(`Cannot verify payment with status: ${paymentRecord.status}`);
      }

      // Verify payment details with Razorpay API
      const rzpPayment = await this.razorpay.payments.fetch(input.razorpayPaymentId);
      if (rzpPayment.order_id !== paymentRecord.razorpayOrderId) {
        throw new BadRequestException('Payment does not match the expected Razorpay order.');
      }
      if (Number(rzpPayment.amount) !== paymentRecord.amountPaise) {
        throw new BadRequestException('Paid amount does not match the required consultation fee.');
      }
      if (rzpPayment.currency !== paymentRecord.currency) {
        throw new BadRequestException('Payment currency mismatch.');
      }
      if (rzpPayment.status !== 'captured' && rzpPayment.status !== 'authorized') {
        throw new BadRequestException(`Payment is not in an authorized or captured state: ${rzpPayment.status}`);
      }

      // Step 2b: Lock appointment row SECOND
      const [apptRecord] = await tx
        .select({
          id: appointment.id,
          doctorId: appointment.doctorId,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
        })
        .from(appointment)
        .where(eq(appointment.id, paymentRecord.appointmentId))
        .for('update')
        .limit(1);

      if (!apptRecord) {
        throw new NotFoundException('Appointment record not found.');
      }

      // Check if slot was reassigned after hold expired
      let canConfirm = true;
      if (apptRecord.status === 'cancelled') {
        canConfirm = await this.hasCapacityForLateCapture(tx, apptRecord);
      }

      if (!canConfirm) {
        // Late captured payment: slot is no longer available. Mark for refund/reconciliation.
        await tx
          .update(payment)
          .set({
            status: 'captured',
            razorpayPaymentId: input.razorpayPaymentId,
            razorpaySignature: input.razorpaySignature,
            failureReason: 'Slot reassigned after hold expiry. Queued for refund/reconciliation.',
            updatedAt: new Date(),
          })
          .where(eq(payment.id, paymentRecord.id));

        await this.enqueuePaymentReceiptEmail(tx, {
          appointmentId: paymentRecord.appointmentId,
          paymentId: paymentRecord.id,
          patientId: paymentRecord.patientId,
          doctorId: paymentRecord.doctorId,
          startsAt: apptRecord.startsAt,
          amountPaise: paymentRecord.amountPaise,
          currency: paymentRecord.currency,
        });

        if (this.notifications) {
          void this.notifications.createNotification({
            userId: paymentRecord.patientId,
            title: 'Appointment Slot Reassigned - Refund Queued',
            message:
              'Your payment was received, but the appointment hold expired and the slot was booked by another patient. A full refund has been queued.',
            type: 'booking',
            appointmentId: apptRecord.id,
          });
        }

        return {
          success: false,
          lateCapture: true,
          appointmentId: paymentRecord.appointmentId,
          paymentId: paymentRecord.id,
          status: 'captured',
          message:
            'Payment was captured, but your appointment hold expired and the slot was taken. A full refund has been queued.',
        };
      }

      // Mark payment as captured
      await tx
        .update(payment)
        .set({
          status: 'captured',
          razorpayPaymentId: input.razorpayPaymentId,
          razorpaySignature: input.razorpaySignature,
          failureReason: null,
          updatedAt: new Date(),
        })
        .where(eq(payment.id, paymentRecord.id));

      // Mark appointment as scheduled and clear temporary hold
      const [updatedAppt] = await tx
        .update(appointment)
        .set({
          status: 'scheduled',
          holdExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(appointment.id, paymentRecord.appointmentId))
        .returning({
          id: appointment.id,
          patientId: appointment.patientId,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
          doctorId: appointment.doctorId,
          updatedAt: appointment.updatedAt,
          reminderGeneration: appointment.reminderGeneration,
        });

      if (updatedAppt) {
        await this.scheduleAppointmentReminders(tx, updatedAppt);
        await this.enqueuePaymentConfirmationEmails(tx, {
          appointmentId: updatedAppt.id,
          paymentId: paymentRecord.id,
          patientId: paymentRecord.patientId,
          doctorId: paymentRecord.doctorId,
          startsAt: updatedAppt.startsAt,
          amountPaise: paymentRecord.amountPaise,
          currency: paymentRecord.currency,
        });
      }

      // Dispatch notifications
      if (this.notifications && updatedAppt) {
        const timezone = await this.scheduleService?.getTimezoneForDoctor(updatedAppt.doctorId);
        const timeFormatted = timezone
          ? new Intl.DateTimeFormat('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: timezone,
            }).format(updatedAppt.startsAt)
          : null;

        void this.notifications.createNotification({
          userId: paymentRecord.patientId,
          title: 'Payment Confirmed & Appointment Booked',
          message: timeFormatted
            ? `Payment successful. Consultation confirmed for ${timeFormatted} (${timezone}).`
            : 'Payment successful. Your consultation is confirmed. Sign in to view the appointment details.',
          type: 'booking',
          appointmentId: updatedAppt.id,
        });

        void this.notifications.createNotification({
          userId: paymentRecord.doctorId,
          title: 'New Paid Appointment',
          message: timeFormatted
            ? `A new consultation has been paid and scheduled for ${timeFormatted} (${timezone}).`
            : 'A new consultation has been paid and scheduled.',
          type: 'booking',
          appointmentId: updatedAppt.id,
        });
      }

      return {
        success: true,
        appointmentId: paymentRecord.appointmentId,
        paymentId: paymentRecord.id,
        status: 'captured',
        startsAt: updatedAppt?.startsAt.toISOString(),
        endsAt: updatedAppt?.endsAt.toISOString(),
      };
    });

    // Auto-trigger late payment reconciliation if slot was reassigned
    if ('lateCapture' in verificationResult && verificationResult.lateCapture) {
      void this.reconcileLatePayment(verificationResult.paymentId);
    }

    return verificationResult;
  }

  /**
   * Securely and idempotently processes refunds via Razorpay API.
   * Can be initiated by admin users or automated background reconciliation.
   */
  async refundPayment(
    actorId: string,
    actorRole: string,
    paymentId: string,
    input: CreateRefundDto,
  ) {
    if (actorRole !== 'admin' && actorRole !== 'system') {
      throw new ForbiddenException('Only administrators or system reconciliation can issue refunds.');
    }

    // 1. Transaction to validate payment state and insert a pending refund record
    const { refundRecord, rzpPaymentId, amountToRefund } = await db.transaction(async (tx) => {
      const [payRecord] = await tx
        .select()
        .from(payment)
        .where(eq(payment.id, paymentId))
        .for('update')
        .limit(1);

      if (!payRecord) {
        throw new NotFoundException('Payment not found.');
      }

      if (payRecord.status !== 'captured' && payRecord.status !== 'refunded') {
        throw new BadRequestException(`Cannot refund payment in '${payRecord.status}' status.`);
      }

      if (!payRecord.razorpayPaymentId) {
        throw new BadRequestException('Cannot refund payment without a valid Razorpay Payment ID.');
      }

      const remainingPaise = payRecord.amountPaise - (payRecord.refundedAmountPaise ?? 0);
      if (remainingPaise <= 0) {
        throw new BadRequestException('Payment is already fully refunded.');
      }

      const amountToRefund = input.amountPaise ?? remainingPaise;
      if (amountToRefund <= 0) {
        throw new BadRequestException('Refund amount must be greater than zero.');
      }
      if (amountToRefund > remainingPaise) {
        throw new BadRequestException(
          `Requested refund amount (${amountToRefund} paise) exceeds remaining balance (${remainingPaise} paise).`,
        );
      }

      // Concurrency check: Ensure no active pending refund exists for this payment
      const [activePendingRefund] = await tx
        .select({ id: refund.id })
        .from(refund)
        .where(and(eq(refund.paymentId, payRecord.id), eq(refund.status, 'pending')))
        .limit(1);

      if (activePendingRefund) {
        throw new ConflictException('A refund is already in progress for this payment.');
      }

      const newRefundId = randomUUID();
      const [createdRefund] = await tx
        .insert(refund)
        .values({
          id: newRefundId,
          paymentId: payRecord.id,
          appointmentId: payRecord.appointmentId,
          patientId: payRecord.patientId,
          doctorId: payRecord.doctorId,
          razorpayPaymentId: payRecord.razorpayPaymentId,
          amountPaise: amountToRefund,
          currency: payRecord.currency,
          status: 'pending',
          reason: input.reason,
          notes: input.notes,
        })
        .returning();

      return {
        refundRecord: createdRefund,
        rzpPaymentId: payRecord.razorpayPaymentId,
        amountToRefund,
      };
    });

    // 2. Call Razorpay Refund API
    try {
      const rzpRefund = await this.razorpay.payments.refund(rzpPaymentId, {
        amount: amountToRefund,
        notes: {
          refundId: refundRecord.id,
          reason: input.reason,
          actorId,
        },
        receipt: `rf_${refundRecord.id.replace(/-/g, '').slice(0, 20)}`,
        speed: 'optimum',
      });

      // 3. Update DB based on Razorpay response
      const updated = await db.transaction(async (tx) => {
        const isProcessed = rzpRefund.status === 'processed';
        const isFailed = rzpRefund.status === 'failed';
        const newStatus: 'processed' | 'pending' | 'failed' = isProcessed
          ? 'processed'
          : isFailed
          ? 'failed'
          : 'pending';

        const [finalRefund] = await tx
          .update(refund)
          .set({
            razorpayRefundId: rzpRefund.id,
            status: newStatus,
            arn: rzpRefund.acquirer_data?.arn ?? null,
            failureReason: isFailed
              ? (rzpRefund as unknown as Record<string, unknown>)?.error_description?.toString() ||
                'Razorpay refund rejected'
              : null,
            updatedAt: new Date(),
          })
          .where(eq(refund.id, refundRecord.id))
          .returning();

        if (isProcessed) {
          const [updatedPay] = await tx
            .select()
            .from(payment)
            .where(eq(payment.id, paymentId))
            .for('update')
            .limit(1);

          const newRefundedPaise = (updatedPay.refundedAmountPaise ?? 0) + amountToRefund;
          const isFullyRefunded = newRefundedPaise >= updatedPay.amountPaise;

          await tx
            .update(payment)
            .set({
              refundedAmountPaise: newRefundedPaise,
              status: isFullyRefunded ? 'refunded' : updatedPay.status,
              updatedAt: new Date(),
            })
            .where(eq(payment.id, paymentId));
        }

        return finalRefund;
      });

      // 4. Notifications
      if (this.notifications) {
        const inrAmount = (amountToRefund / 100).toFixed(2);
        void this.notifications.createNotification({
          userId: refundRecord.patientId,
          title: 'Refund Processed',
          message: `A refund of ₹${inrAmount} for your consultation has been initiated (Status: ${updated.status}).`,
          type: 'booking',
          appointmentId: refundRecord.appointmentId,
        });
      }

      return updated;
    } catch (err: any) {
      const isConfirmedClientError =
        (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) ||
        (err?.error && typeof err.error.code === 'string' && err.error.code.startsWith('BAD_REQUEST'));

      if (isConfirmedClientError) {
        // Confirmed gateway rejection: safe to mark failed
        const failureReason =
          err?.error?.description || err?.error?.reason || err?.message || 'Razorpay refund rejected';
        await db
          .update(refund)
          .set({
            status: 'failed',
            failureReason,
            updatedAt: new Date(),
          })
          .where(eq(refund.id, refundRecord.id));

        throw new BadRequestException(failureReason);
      }

      // Ambiguous error (timeout, network disconnection, 5xx):
      // NEVER treat as confirmed failure! Keep status as 'pending' with failureReason explaining the uncertainty
      const ambiguousReason =
        `GATEWAY_TIMEOUT: Refund status uncertain due to network timeout or gateway error (${err?.message || 'timeout'}). Preserved for reconciliation.`;

      this.logger.warn(
        `Refund attempt ${refundRecord.id} for payment ${paymentId} encountered ambiguous error: ${err?.message}. Preserving as pending for reconciliation.`,
      );

      await db
        .update(refund)
        .set({
          failureReason: ambiguousReason,
          updatedAt: new Date(),
        })
        .where(eq(refund.id, refundRecord.id));

      throw new BadRequestException(
        'Refund request timed out or encountered network error. Status is pending reconciliation.',
      );
    }
  }

  /**
   * Automatically reconciles late payments where the slot was reassigned after hold expiry.
   */
  async reconcileLatePayment(paymentId: string) {
    try {
      if (!db?.select) {
        return;
      }
      const query = db.select();
      if (!query?.from) {
        return;
      }
      const [payRecord] = await query
        .from(payment)
        .where(eq(payment.id, paymentId))
        .limit(1);

      if (!payRecord || payRecord.status !== 'captured') {
        return;
      }

      const remainingPaise = payRecord.amountPaise - (payRecord.refundedAmountPaise ?? 0);
      if (remainingPaise <= 0) {
        return;
      }

      // Check if refund is already pending
      const [pendingRefund] = await db
        .select({ id: refund.id })
        .from(refund)
        .where(and(eq(refund.paymentId, payRecord.id), eq(refund.status, 'pending')))
        .limit(1);

      if (pendingRefund) {
        return;
      }

      this.logger.log(`Auto-triggering refund reconciliation for late payment: ${paymentId}`);
      await this.refundPayment('SYSTEM_RECONCILIATION', 'system', payRecord.id, {
        reason: 'Automated refund: consultation slot reassigned after hold expiry',
      });
    } catch (err) {
      this.logger.error(`Late payment reconciliation failed for payment ${paymentId}:`, err);
    }
  }

  /**
   * Handles asynchronous Razorpay webhook events:
   * - `payment.captured`
   * - `order.paid`
   * - `payment.failed`
   * - `refund.created`
   * - `refund.processed`
   * - `refund.failed`
   */
  async handleWebhook(signature: string | undefined, rawBody: Buffer | string | undefined, payload: any) {
    if (!signature) {
      throw new BadRequestException('Missing x-razorpay-signature header.');
    }
    if (!rawBody) {
      throw new BadRequestException('Missing request raw body for webhook verification.');
    }

    const isValidSignature = this.verifyWebhookHmac(rawBody, signature, this.env.razorpayWebhookSecret);
    if (!isValidSignature) {
      throw new BadRequestException('Invalid webhook signature.');
    }

    const event = payload?.event;

    // --- Payment Captured or Order Paid ---
    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = payload?.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id ?? payload?.payload?.order?.entity?.id;
      const paymentId = paymentEntity?.id;

      if (!orderId) {
        return { received: true, note: 'No order_id present in webhook payload.' };
      }

      let reassignedPaymentId: string | null = null;

      const result = await db.transaction(async (tx) => {
        // Step 1: Lock payment row FIRST
        const [paymentRecord] = await tx
          .select()
          .from(payment)
          .where(eq(payment.razorpayOrderId, orderId))
          .for('update')
          .limit(1);

        if (!paymentRecord) {
          return { received: true, note: 'Payment record not found.' };
        }

        if (paymentRecord.status === 'captured') {
          return { received: true, note: 'Already captured.' };
        }

        // Step 2: Lock appointment row SECOND
        const [apptRecord] = await tx
          .select({
            id: appointment.id,
            doctorId: appointment.doctorId,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            status: appointment.status,
          })
          .from(appointment)
          .where(eq(appointment.id, paymentRecord.appointmentId))
          .for('update')
          .limit(1);

        if (!apptRecord) {
          return { received: true, note: 'Associated appointment not found.' };
        }

        let canConfirm = true;
        if (apptRecord.status === 'cancelled') {
          canConfirm = await this.hasCapacityForLateCapture(tx, apptRecord);
        }

        if (!canConfirm) {
          await tx
            .update(payment)
            .set({
              status: 'captured',
              razorpayPaymentId: paymentId ?? paymentRecord.razorpayPaymentId,
              failureReason: 'Slot reassigned after hold expiry. Queued for refund/reconciliation.',
              updatedAt: new Date(),
            })
            .where(eq(payment.id, paymentRecord.id));

          await this.enqueuePaymentReceiptEmail(tx, {
            appointmentId: paymentRecord.appointmentId,
            paymentId: paymentRecord.id,
            patientId: paymentRecord.patientId,
            doctorId: paymentRecord.doctorId,
            startsAt: apptRecord.startsAt,
            amountPaise: paymentRecord.amountPaise,
            currency: paymentRecord.currency,
          });

          reassignedPaymentId = paymentRecord.id;

          if (this.notifications) {
            void this.notifications.createNotification({
              userId: paymentRecord.patientId,
              title: 'Hold Expired - Payment Queued for Refund',
              message:
                'Your payment was captured, but the consultation slot was reassigned after hold expiry. A full refund has been initiated.',
              type: 'booking',
              appointmentId: apptRecord.id,
            });
          }

          return { received: true, status: 'captured', note: 'Slot reassigned, refund queued' };
        }

        await tx
          .update(payment)
          .set({
            status: 'captured',
            razorpayPaymentId: paymentId ?? paymentRecord.razorpayPaymentId,
            failureReason: null,
            updatedAt: new Date(),
          })
          .where(eq(payment.id, paymentRecord.id));

        const [updatedAppt] = await tx
          .update(appointment)
          .set({
            status: 'scheduled',
            holdExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(appointment.id, paymentRecord.appointmentId))
          .returning({
            id: appointment.id,
            patientId: appointment.patientId,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            status: appointment.status,
            doctorId: appointment.doctorId,
            updatedAt: appointment.updatedAt,
            reminderGeneration: appointment.reminderGeneration,
          });

        if (updatedAppt) {
          await this.scheduleAppointmentReminders(tx, updatedAppt);
          await this.enqueuePaymentConfirmationEmails(tx, {
            appointmentId: updatedAppt.id,
            paymentId: paymentRecord.id,
            patientId: paymentRecord.patientId,
            doctorId: paymentRecord.doctorId,
            startsAt: updatedAppt.startsAt,
            amountPaise: paymentRecord.amountPaise,
            currency: paymentRecord.currency,
          });
        }

        if (this.notifications && updatedAppt) {
          const timezone = await this.scheduleService?.getTimezoneForDoctor(updatedAppt.doctorId);
          const timeFormatted = timezone
            ? new Intl.DateTimeFormat('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: timezone,
              }).format(updatedAppt.startsAt)
            : null;

          void this.notifications.createNotification({
            userId: paymentRecord.patientId,
            title: 'Payment Confirmed & Appointment Booked',
            message: timeFormatted
              ? `Payment successful. Consultation confirmed for ${timeFormatted} (${timezone}).`
              : 'Payment successful. Your consultation is confirmed. Sign in to view the appointment details.',
            type: 'booking',
            appointmentId: updatedAppt.id,
          });

          void this.notifications.createNotification({
            userId: paymentRecord.doctorId,
            title: 'New Paid Appointment',
            message: timeFormatted
              ? `A new consultation has been paid and scheduled for ${timeFormatted} (${timezone}).`
              : 'A new consultation has been paid and scheduled.',
            type: 'booking',
            appointmentId: updatedAppt.id,
          });
        }

        return { received: true, status: 'captured' };
      });

      if (reassignedPaymentId) {
        void this.reconcileLatePayment(reassignedPaymentId);
      }

      return result;
    }

    // --- Payment Failed ---
    if (event === 'payment.failed') {
      const paymentEntity = payload?.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      const failureReason = paymentEntity?.error_description || 'Payment failed';

      if (orderId) {
        await db
          .update(payment)
          .set({
            status: 'failed',
            failureReason,
            updatedAt: new Date(),
          })
          .where(eq(payment.razorpayOrderId, orderId));
      }
      return { received: true, status: 'failed' };
    }

    // --- Refund Created ---
    if (event === 'refund.created') {
      const refundEntity = payload?.payload?.refund?.entity;
      const rzpRefundId = refundEntity?.id;
      const rzpPaymentId = refundEntity?.payment_id;

      if (rzpRefundId && rzpPaymentId) {
        const [existingRefund] = await db
          .select()
          .from(refund)
          .where(
            or(
              eq(refund.razorpayRefundId, rzpRefundId),
              and(eq(refund.razorpayPaymentId, rzpPaymentId), eq(refund.status, 'pending')),
            ),
          )
          .limit(1);

        if (existingRefund && !existingRefund.razorpayRefundId) {
          await db
            .update(refund)
            .set({
              razorpayRefundId: rzpRefundId,
              arn: refundEntity?.acquirer_data?.arn ?? existingRefund.arn,
              updatedAt: new Date(),
            })
            .where(eq(refund.id, existingRefund.id));
        }
      }
      return { received: true, status: 'acknowledged' };
    }

    // --- Refund Processed ---
    if (event === 'refund.processed') {
      const refundEntity = payload?.payload?.refund?.entity;
      const rzpRefundId = refundEntity?.id;
      const rzpPaymentId = refundEntity?.payment_id;
      const amountPaise = Number(refundEntity?.amount);
      const arn = refundEntity?.acquirer_data?.arn;

      if (!rzpRefundId || !rzpPaymentId) {
        return { received: true, note: 'Missing refund/payment ID in refund.processed webhook.' };
      }

      return db.transaction(async (tx) => {
        let [refundRecord] = await tx
          .select()
          .from(refund)
          .where(
            or(
              eq(refund.razorpayRefundId, rzpRefundId),
              and(eq(refund.razorpayPaymentId, rzpPaymentId), eq(refund.status, 'pending')),
            ),
          )
          .for('update')
          .limit(1);
        let transitionedToProcessed = false;

        if (!refundRecord) {
          // If refund was initiated externally in Razorpay Dashboard, create audit record
          const [payRecord] = await tx
            .select()
            .from(payment)
            .where(eq(payment.razorpayPaymentId, rzpPaymentId))
            .for('update')
            .limit(1);

          if (!payRecord) {
            return { received: true, note: 'Associated payment not found.' };
          }

          const newRefundId = randomUUID();
          const [inserted] = await tx
            .insert(refund)
            .values({
              id: newRefundId,
              paymentId: payRecord.id,
              appointmentId: payRecord.appointmentId,
              patientId: payRecord.patientId,
              doctorId: payRecord.doctorId,
              razorpayPaymentId: rzpPaymentId,
              razorpayRefundId: rzpRefundId,
              amountPaise: amountPaise || payRecord.amountPaise,
              currency: payRecord.currency,
              status: 'processed',
              reason: 'External refund via Razorpay Dashboard',
              arn: arn ?? null,
            })
            .returning();
          refundRecord = inserted;
          transitionedToProcessed = Boolean(inserted);
        } else {
          if (refundRecord.status === 'processed') {
            return { received: true, note: 'Refund already processed.' };
          }

          const update: Partial<typeof refund.$inferInsert> = {
            razorpayRefundId: rzpRefundId,
            status: 'processed',
            failureReason: null,
            updatedAt: new Date(),
          };
          if (arn) update.arn = arn;
          const [processedRecord] = await tx
            .update(refund)
            .set(update)
            .where(and(eq(refund.id, refundRecord.id), eq(refund.status, 'pending')))
            .returning();
          if (!processedRecord) {
            return { received: true, note: 'Refund was already transitioned.' };
          }
          refundRecord = processedRecord;
          transitionedToProcessed = true;
        }

        if (!transitionedToProcessed || !refundRecord) {
          return { received: true, note: 'Refund was already transitioned.' };
        }

        // Increment payment refunded amount and update status if fully refunded
        const [payRecord] = await tx
          .select()
          .from(payment)
          .where(eq(payment.id, refundRecord.paymentId))
          .for('update')
          .limit(1);

        if (payRecord) {
          const newRefundedPaise = (payRecord.refundedAmountPaise ?? 0) + refundRecord.amountPaise;
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

        await this.enqueueRefundProcessedEmail(tx, {
          id: refundRecord.id,
          patientId: refundRecord.patientId,
          appointmentId: refundRecord.appointmentId,
          paymentId: refundRecord.paymentId,
          amountPaise: refundRecord.amountPaise,
          currency: refundRecord.currency,
        }, refundRecord.arn);

        if (this.notifications) {
          const inrAmount = (refundRecord.amountPaise / 100).toFixed(2);
          void this.notifications.createNotification({
            userId: refundRecord.patientId,
            title: 'Refund Processed',
            message: `Your refund of ₹${inrAmount} has been processed successfully${refundRecord.arn ? ` (ARN: ${refundRecord.arn})` : ''}.`,
            type: 'booking',
            appointmentId: refundRecord.appointmentId,
          });
        }

        return { received: true, status: 'processed', refundId: refundRecord.id };
      });
    }

    // --- Refund Failed ---
    if (event === 'refund.failed') {
      const refundEntity = payload?.payload?.refund?.entity;
      const rzpRefundId = refundEntity?.id;
      const rzpPaymentId = refundEntity?.payment_id;
      const failureReason = refundEntity?.error_description || 'Refund failed by gateway';

      if (rzpRefundId) {
        await db
          .update(refund)
          .set({
            razorpayRefundId: rzpRefundId,
            status: 'failed',
            failureReason,
            updatedAt: new Date(),
          })
          .where(
            or(
              eq(refund.razorpayRefundId, rzpRefundId),
              ...(rzpPaymentId
                ? [and(eq(refund.razorpayPaymentId, rzpPaymentId), eq(refund.status, 'pending'))]
                : []),
            ),
          );
      }
      return { received: true, status: 'failed' };
    }

    return { received: true, note: `Unhandled event: ${event}` };
  }

  /**
   * Admin: List payments with optional status filter and pagination.
   */
  async adminListPayments(query: AdminListPaymentsQueryDto) {
    const conditions = [];
    if (query.status) {
      conditions.push(eq(payment.status, query.status));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [payments, [{ count: totalCount }]] = await Promise.all([
      db
        .select({
          id: payment.id,
          appointmentId: payment.appointmentId,
          patientId: payment.patientId,
          doctorId: payment.doctorId,
          razorpayOrderId: payment.razorpayOrderId,
          razorpayPaymentId: payment.razorpayPaymentId,
          amountPaise: payment.amountPaise,
          currency: payment.currency,
          status: payment.status,
          receipt: payment.receipt,
          failureReason: payment.failureReason,
          refundedAmountPaise: payment.refundedAmountPaise,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt,
          patientName: user.name,
          patientEmail: user.email,
        })
        .from(payment)
        .leftJoin(user, eq(payment.patientId, user.id))
        .where(whereClause)
        .orderBy(desc(payment.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(payment)
        .where(whereClause),
    ]);

    return {
      payments,
      totalCount,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Admin: Get comprehensive payment details along with all associated refunds.
   */
  async adminGetPaymentDetails(paymentId: string) {
    const [record] = await db
      .select({
        id: payment.id,
        appointmentId: payment.appointmentId,
        patientId: payment.patientId,
        doctorId: payment.doctorId,
        razorpayOrderId: payment.razorpayOrderId,
        razorpayPaymentId: payment.razorpayPaymentId,
        amountPaise: payment.amountPaise,
        currency: payment.currency,
        status: payment.status,
        receipt: payment.receipt,
        failureReason: payment.failureReason,
        refundedAmountPaise: payment.refundedAmountPaise,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      })
      .from(payment)
      .where(eq(payment.id, paymentId))
      .limit(1);

    if (!record) {
      throw new NotFoundException('Payment not found.');
    }

    const [refundList, [appt]] = await Promise.all([
      db
        .select()
        .from(refund)
        .where(eq(refund.paymentId, record.id))
        .orderBy(desc(refund.createdAt)),
      db
        .select({
          id: appointment.id,
          status: appointment.status,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
        })
        .from(appointment)
        .where(eq(appointment.id, record.appointmentId))
        .limit(1),
    ]);

    return {
      ...record,
      appointment: appt ?? null,
      refunds: refundList,
    };
  }

  /**
   * Admin: List refunds with optional status and payment filters.
   */
  async adminListRefunds(query: AdminListRefundsQueryDto) {
    const conditions = [];
    if (query.status) {
      conditions.push(eq(refund.status, query.status));
    }
    if (query.paymentId) {
      conditions.push(eq(refund.paymentId, query.paymentId));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [refunds, [{ count: totalCount }]] = await Promise.all([
      db
        .select()
        .from(refund)
        .where(whereClause)
        .orderBy(desc(refund.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(refund)
        .where(whereClause),
    ]);

    return {
      refunds,
      totalCount,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Cryptographically verifies HMAC-SHA256 signature in constant time.
   */
  verifyHmacSignature(orderId: string, paymentId: string, signature: string, secret: string): boolean {
    const data = `${orderId}|${paymentId}`;
    const expected = createHmac('sha256', secret).update(data).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(signature, 'utf8');

    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, actualBuf);
  }

  /**
   * Cryptographically verifies raw webhook request HMAC-SHA256 signature in constant time.
   */
  verifyWebhookHmac(rawBody: Buffer | string, signature: string, secret: string): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(signature, 'utf8');

    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, actualBuf);
  }
}
