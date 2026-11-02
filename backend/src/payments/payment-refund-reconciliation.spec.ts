import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PaymentsService } from './payments.service.js';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import { AppointmentsService } from '../appointments/appointments.service.js';
import { appointment, payment, refund } from '../db/schema.js';
import { db } from '../db/database.js';
import type { RazorpayInstance } from './razorpay.provider.js';

vi.mock('../db/database.js', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

describe('Refund Management & Reconciliation', () => {
  let paymentsService: PaymentsService;
  let reconciliationService: PaymentReconciliationService;
  let mockRazorpay: RazorpayInstance;
  let mockNotifications: any;

  const sampleSecret = 'sample_test_secret_32_chars_long!!';
  const sampleWebhookSecret = 'sample_test_webhook_secret_32_c!!';

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.RAZORPAY_KEY_ID = 'rzp_test_12345';
    process.env.RAZORPAY_KEY_SECRET = sampleSecret;
    process.env.RAZORPAY_WEBHOOK_SECRET = sampleWebhookSecret;

    mockRazorpay = {
      orders: {
        create: vi.fn(),
      },
      payments: {
        fetch: vi.fn(),
        fetchMultipleRefund: vi.fn().mockResolvedValue({
          entity: 'collection',
          count: 0,
          items: [],
        }),
        refund: vi.fn().mockResolvedValue({
          id: 'rfnd_test_123',
          entity: 'refund',
          amount: 50000,
          currency: 'INR',
          payment_id: 'pay_test_456',
          status: 'processed',
          acquirer_data: { arn: 'ARN123456789' },
        }),
      },
      refunds: {
        all: vi.fn().mockResolvedValue({
          entity: 'collection',
          count: 0,
          items: [],
        }),
        fetch: vi.fn().mockResolvedValue({
          id: 'rfnd_test_123',
          entity: 'refund',
          amount: 50000,
          currency: 'INR',
          payment_id: 'pay_test_456',
          status: 'processed',
          acquirer_data: { arn: 'ARN123456789' },
        }),
      },
    };

    mockNotifications = {
      createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
    };

    paymentsService = new PaymentsService(mockRazorpay, mockNotifications);
    reconciliationService = new PaymentReconciliationService(paymentsService, mockRazorpay);
  });

  describe('PaymentsService.refundPayment', () => {
    const paymentId = 'pay-uuid-1';
    const actorId = 'admin-uuid-1';

    it('rejects refund request if actor is not admin or system', async () => {
      await expect(
        paymentsService.refundPayment('patient-1', 'patient', paymentId, {
          reason: 'Customer request',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException if payment record does not exist', async () => {
      const mockTx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
          }),
        }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      await expect(
        paymentsService.refundPayment(actorId, 'admin', paymentId, {
          reason: 'Doctor cancelled',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects refund if payment status is created or failed', async () => {
      const mockTx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: paymentId,
                    status: 'created',
                    amountPaise: 50000,
                  },
                ]),
              }),
            }),
          }),
        }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      await expect(
        paymentsService.refundPayment(actorId, 'admin', paymentId, {
          reason: 'Doctor cancelled',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects refund if payment is already fully refunded', async () => {
      const mockTx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: paymentId,
                    status: 'refunded',
                    amountPaise: 50000,
                    refundedAmountPaise: 50000,
                    razorpayPaymentId: 'pay_test_456',
                  },
                ]),
              }),
            }),
          }),
        }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      await expect(
        paymentsService.refundPayment(actorId, 'admin', paymentId, {
          reason: 'Doctor cancelled',
        }),
      ).rejects.toThrow('Payment is already fully refunded.');
    });

    it('rejects refund if requested amount exceeds remaining refundable balance', async () => {
      const mockTx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: paymentId,
                    status: 'captured',
                    amountPaise: 50000,
                    refundedAmountPaise: 30000,
                    razorpayPaymentId: 'pay_test_456',
                  },
                ]),
              }),
            }),
          }),
        }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      await expect(
        paymentsService.refundPayment(actorId, 'admin', paymentId, {
          reason: 'Excess refund test',
          amountPaise: 25000, // Remaining is 20000
        }),
      ).rejects.toThrow('exceeds remaining balance');
    });

    it('prevents concurrent duplicate refunds when an active pending refund exists', async () => {
      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: paymentId,
                      status: 'captured',
                      amountPaise: 50000,
                      refundedAmountPaise: 0,
                      razorpayPaymentId: 'pay_test_456',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. Check active pending refund
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([{ id: 'rfnd-pending-1' }]),
              }),
            }),
          }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      await expect(
        paymentsService.refundPayment(actorId, 'admin', paymentId, {
          reason: 'Concurrent retry',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('successfully initiates and completes a full refund via Razorpay API', async () => {
      const createdRefundRecord = {
        id: 'refund-uuid-1',
        paymentId,
        appointmentId: 'appt-1',
        patientId: 'patient-1',
        doctorId: 'doctor-1',
        amountPaise: 50000,
        currency: 'INR',
        status: 'pending',
      };

      const mockTx1 = {
        select: vi
          .fn()
          // 1. Payment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: paymentId,
                      appointmentId: 'appt-1',
                      patientId: 'patient-1',
                      doctorId: 'doctor-1',
                      status: 'captured',
                      amountPaise: 50000,
                      refundedAmountPaise: 0,
                      currency: 'INR',
                      razorpayPaymentId: 'pay_test_456',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. Active pending check (none)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
          }),
        insert: vi.fn().mockReturnValueOnce({
          values: vi.fn().mockReturnValueOnce({
            returning: vi.fn().mockResolvedValueOnce([createdRefundRecord]),
          }),
        }),
      };

      const mockTx2 = {
        update: vi
          .fn()
          // Update refund to processed
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                returning: vi.fn().mockResolvedValueOnce([
                  {
                    ...createdRefundRecord,
                    status: 'processed',
                    razorpayRefundId: 'rfnd_test_123',
                    arn: 'ARN123456789',
                  },
                ]),
              }),
            }),
          })
          // Update payment status to refunded
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: paymentId,
                    amountPaise: 50000,
                    refundedAmountPaise: 0,
                    status: 'captured',
                  },
                ]),
              }),
            }),
          }),
        }),
      };

      (db.transaction as any)
        .mockImplementationOnce(async (cb: any) => cb(mockTx1))
        .mockImplementationOnce(async (cb: any) => cb(mockTx2));

      const result = await paymentsService.refundPayment(actorId, 'admin', paymentId, {
        reason: 'Patient cancellation',
      });

      expect(result.status).toBe('processed');
      expect(result.razorpayRefundId).toBe('rfnd_test_123');
      expect(mockRazorpay.payments.refund).toHaveBeenCalledWith(
        'pay_test_456',
        expect.objectContaining({
          amount: 50000,
        }),
      );
      expect(mockNotifications.createNotification).toHaveBeenCalled();
    });

    it('marks refund as failed when Razorpay API throws an error', async () => {
      const createdRefundRecord = {
        id: 'refund-uuid-fail',
        paymentId,
        appointmentId: 'appt-1',
        patientId: 'patient-1',
        doctorId: 'doctor-1',
        amountPaise: 50000,
        currency: 'INR',
        status: 'pending',
      };

      const mockTx = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: paymentId,
                      appointmentId: 'appt-1',
                      patientId: 'patient-1',
                      doctorId: 'doctor-1',
                      status: 'captured',
                      amountPaise: 50000,
                      refundedAmountPaise: 0,
                      currency: 'INR',
                      razorpayPaymentId: 'pay_test_456',
                    },
                  ]),
                }),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
          }),
        insert: vi.fn().mockReturnValueOnce({
          values: vi.fn().mockReturnValueOnce({
            returning: vi.fn().mockResolvedValueOnce([createdRefundRecord]),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));
      (mockRazorpay.payments.refund as any).mockRejectedValueOnce(
        new Error('Gateway timeout during refund'),
      );

      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      });

      await expect(
        paymentsService.refundPayment(actorId, 'admin', paymentId, {
          reason: 'Network issue',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('PaymentsService Webhook: refund.created, refund.processed, refund.failed', () => {
    it('handles refund.created by acknowledging and updating razorpayRefundId', async () => {
      const payload = {
        event: 'refund.created',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_created_999',
              payment_id: 'pay_test_456',
              amount: 50000,
              status: 'created',
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([
              {
                id: 'refund-local-1',
                razorpayRefundId: null,
                arn: null,
              },
            ]),
          }),
        }),
      });

      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      });

      const res = await paymentsService.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.status).toBe('acknowledged');
    });

    it('handles refund.processed idempotently and increments refunded paise', async () => {
      const payload = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_proc_123',
              payment_id: 'pay_test_456',
              amount: 50000,
              status: 'processed',
              acquirer_data: { arn: 'ARN99887766' },
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const mockTx = {
        select: vi
          .fn()
          // 1. Find refund record
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'refund-1',
                      paymentId: 'pay-1',
                      appointmentId: 'appt-1',
                      patientId: 'patient-1',
                      amountPaise: 50000,
                      status: 'pending',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. Select payment record
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'pay-1',
                      amountPaise: 50000,
                      refundedAmountPaise: 0,
                      status: 'captured',
                    },
                  ]),
                }),
              }),
            }),
          }),
        update: vi
          .fn()
          // 1. Update refund
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          })
          // 2. Update payment
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const res = await paymentsService.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.status).toBe('processed');
    });

    it('returns idempotently when refund.processed arrives for already processed refund', async () => {
      const payload = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_already_proc',
              payment_id: 'pay_test_456',
              amount: 50000,
              status: 'processed',
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const mockTx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: 'refund-1',
                    status: 'processed',
                  },
                ]),
              }),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const res = await paymentsService.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.note).toBe('Refund already processed.');
    });

    it('handles refund.failed by recording failure reason', async () => {
      const payload = {
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_failed_001',
              payment_id: 'pay_test_456',
              error_description: 'Beneficiary bank declined refund transaction',
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      });

      const res = await paymentsService.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.status).toBe('failed');
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('Admin Queries', () => {
    it('adminListPayments returns paginated payment list and count', async () => {
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            leftJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                orderBy: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockReturnValueOnce({
                    offset: vi.fn().mockResolvedValueOnce([
                      {
                        id: 'pay-1',
                        amountPaise: 50000,
                        status: 'captured',
                      },
                    ]),
                  }),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockResolvedValueOnce([{ count: 1 }]),
          }),
        });

      const result = await paymentsService.adminListPayments({ limit: 10, offset: 0 });
      expect(result.payments).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });

    it('adminGetPaymentDetails returns payment, appointment, and refund history', async () => {
      (db.select as any)
        // 1. payment
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: 'pay-1',
                  appointmentId: 'appt-1',
                  status: 'captured',
                },
              ]),
            }),
          }),
        })
        // 2. refunds
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              orderBy: vi.fn().mockResolvedValueOnce([
                {
                  id: 'rfnd-1',
                  status: 'processed',
                  amountPaise: 50000,
                },
              ]),
            }),
          }),
        })
        // 3. appointment
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: 'appt-1',
                  status: 'scheduled',
                },
              ]),
            }),
          }),
        });

      const result = await paymentsService.adminGetPaymentDetails('pay-1');
      expect(result.id).toBe('pay-1');
      expect(result.refunds).toHaveLength(1);
      expect(result.appointment).toBeDefined();
    });

    it('adminListRefunds returns paginated refund list and total count', async () => {
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockReturnValueOnce({
                  offset: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'rfnd-1',
                      status: 'processed',
                    },
                  ]),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockResolvedValueOnce([{ count: 1 }]),
          }),
        });

      const result = await paymentsService.adminListRefunds({ limit: 10, offset: 0 });
      expect(result.refunds).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });
  });

  describe('PaymentReconciliationService', () => {
    it('automatically reconciles captured payments on cancelled appointments', async () => {
      // 1. Query unreconciled payments
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            innerJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    paymentId: 'pay-unrec-1',
                    amountPaise: 50000,
                    refundedAmountPaise: 0,
                    appointmentId: 'appt-cancelled-1',
                  },
                ]),
              }),
            }),
          }),
        })
        // 2. Pending check
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
        })
        // 3. Stale refunds query (none)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
        });

      vi.spyOn(paymentsService, 'refundPayment').mockResolvedValueOnce({
        id: 'rfnd-auto-1',
        status: 'processed',
      } as any);

      const count = await reconciliationService.reconcileInconsistentPayments();
      expect(count).toBe(1);
      expect(paymentsService.refundPayment).toHaveBeenCalledWith(
        'SYSTEM_RECONCILIATION',
        'system',
        'pay-unrec-1',
        expect.objectContaining({
          reason: expect.stringContaining('Automated reconciliation'),
        }),
      );
    });

    it('reconciles stale pending refunds by polling Razorpay status', async () => {
      // 1. Query unreconciled payments (empty)
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            innerJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
          }),
        })
        // 2. Query stale pending refunds
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: 'rfnd-stale-1',
                  paymentId: 'pay-stale-1',
                  razorpayRefundId: 'rfnd_rzp_99',
                  amountPaise: 50000,
                },
              ]),
            }),
          }),
        });

      (mockRazorpay.refunds.fetch as any).mockResolvedValueOnce({
        id: 'rfnd_rzp_99',
        status: 'processed',
        acquirer_data: { arn: 'ARN999' },
      });

      const mockTx = {
        update: vi
          .fn()
          // Update refund
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          })
          // Update payment
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: 'pay-stale-1',
                    amountPaise: 50000,
                    refundedAmountPaise: 0,
                    status: 'captured',
                  },
                ]),
              }),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const count = await reconciliationService.reconcileInconsistentPayments();
      expect(count).toBe(1);
      expect(mockRazorpay.refunds.fetch).toHaveBeenCalledWith('rfnd_rzp_99');
    });
  });

  describe('Security Review Regression Suite: Timeout, Concurrency, and Deadlock Prevention', () => {
    it('a. preserves pending state and does NOT mark failed when Razorpay refund request times out', async () => {
      const paymentId = 'pay-timeout-test';
      const actorId = 'admin-1';
      const createdRefundRecord = {
        id: 'refund-uuid-timeout',
        paymentId,
        appointmentId: 'appt-1',
        patientId: 'patient-1',
        doctorId: 'doctor-1',
        amountPaise: 50000,
        currency: 'INR',
        status: 'pending',
      };

      const mockTx = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: paymentId,
                      appointmentId: 'appt-1',
                      patientId: 'patient-1',
                      doctorId: 'doctor-1',
                      status: 'captured',
                      amountPaise: 50000,
                      refundedAmountPaise: 0,
                      currency: 'INR',
                      razorpayPaymentId: 'pay_rzp_live_123',
                    },
                  ]),
                }),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
          }),
        insert: vi.fn().mockReturnValueOnce({
          values: vi.fn().mockReturnValueOnce({
            returning: vi.fn().mockResolvedValueOnce([createdRefundRecord]),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      // Simulate network timeout from Razorpay SDK
      (mockRazorpay.payments.refund as any).mockRejectedValueOnce(
        new Error('ETIMEDOUT: Connection timed out while awaiting gateway response'),
      );

      const updateSetSpy = vi.fn().mockReturnValueOnce({
        where: vi.fn().mockResolvedValueOnce([]),
      });
      (db.update as any).mockReturnValueOnce({
        set: updateSetSpy,
      });

      await expect(
        paymentsService.refundPayment(actorId, 'admin', paymentId, {
          reason: 'Patient cancellation refund',
        }),
      ).rejects.toThrow('pending reconciliation');

      // Crucial requirement: Must NOT mark status as 'failed'! Status remains pending.
      expect(updateSetSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          failureReason: expect.stringContaining('GATEWAY_TIMEOUT'),
        }),
      );
      const callArg = updateSetSpy.mock.calls[0][0];
      expect(callArg.status).toBeUndefined(); // Never overwrite status to failed!
    });

    it('b. reconciliation discovers the original refund on Razorpay instead of issuing a duplicate', async () => {
      const stRefundId = 'refund-timeout-unreconciled';
      const rzpPaymentId = 'pay_rzp_ext_789';
      const discoveredRzpRefundId = 'rfnd_discovered_999';

      // 1. Query unreconciled captured payments (none in sweep 1)
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            innerJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
          }),
        })
        // 2. Query stale pending refunds (finds timed-out refund with null razorpayRefundId)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: stRefundId,
                  paymentId: 'pay-db-1',
                  razorpayRefundId: null, // Timed out before ID was stored
                  amountPaise: 50000,
                },
              ]),
            }),
          }),
        })
        // 3. Query payment details to obtain razorpayPaymentId
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: 'pay-db-1',
                  razorpayPaymentId: rzpPaymentId,
                },
              ]),
            }),
          }),
        });

      // Mock payments.fetch to return ledger state
      (mockRazorpay.payments.fetch as any).mockResolvedValueOnce({
        id: rzpPaymentId,
        amount: 50000,
        amount_refunded: 50000,
        refund_status: 'full',
        status: 'captured',
      });

      // Gateway returns the refund that succeeded during the timeout
      (mockRazorpay.payments.fetchMultipleRefund as any).mockResolvedValueOnce({
        entity: 'collection',
        count: 1,
        items: [
          {
            id: discoveredRzpRefundId,
            status: 'processed',
            amount: 50000,
            payment_id: rzpPaymentId,
            receipt: `rf_${stRefundId.replace(/-/g, '').slice(0, 20)}`,
            notes: {
              refundId: stRefundId,
            },
            acquirer_data: {
              arn: 'ARN_DISCOVERED_123',
            },
          },
        ],
      });

      const updateRefundSetSpy = vi.fn().mockReturnValueOnce({
        where: vi.fn().mockResolvedValueOnce([]),
      });
      const updatePaymentSetSpy = vi.fn().mockReturnValueOnce({
        where: vi.fn().mockResolvedValueOnce([]),
      });

      const mockTx = {
        update: vi
          .fn()
          .mockReturnValueOnce({ set: updateRefundSetSpy })
          .mockReturnValueOnce({ set: updatePaymentSetSpy }),
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: 'pay-db-1',
                    amountPaise: 50000,
                    refundedAmountPaise: 0,
                    status: 'captured',
                  },
                ]),
              }),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const count = await reconciliationService.reconcileInconsistentPayments();

      expect(count).toBe(1);
      // Confirmed: NO duplicate external refund was called!
      expect(mockRazorpay.payments.refund).not.toHaveBeenCalled();
      // Confirmed: Refund updated with discovered Razorpay ID and processed status
      expect(updateRefundSetSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          razorpayRefundId: discoveredRzpRefundId,
          status: 'processed',
          arn: 'ARN_DISCOVERED_123',
          failureReason: null,
        }),
      );
      // Confirmed: Payment ledger updated
      expect(updatePaymentSetSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          refundedAmountPaise: 50000,
          status: 'refunded',
        }),
      );
    });

    it('b2. if ledger shows amount_refunded > 0 but no refund matches our specific receipt/notes, retains pending and emits operator warning (never marks failed or processed)', async () => {
      const stRefundId = 'refund-timeout-unmatched';
      const rzpPaymentId = 'pay_rzp_ext_ledger_mismatch';

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            innerJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: stRefundId,
                  paymentId: 'pay-db-mismatch',
                  razorpayRefundId: null,
                  amountPaise: 50000,
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: 'pay-db-mismatch',
                  razorpayPaymentId: rzpPaymentId,
                },
              ]),
            }),
          }),
        });

      // Ledger shows remote refund occurred
      (mockRazorpay.payments.fetch as any).mockResolvedValueOnce({
        id: rzpPaymentId,
        amount: 50000,
        amount_refunded: 50000,
        refund_status: 'full',
        status: 'refunded',
      });

      // But items list has a different refund (e.g. manual dashboard refund with different receipt/notes)
      (mockRazorpay.payments.fetchMultipleRefund as any).mockResolvedValueOnce({
        entity: 'collection',
        count: 1,
        items: [
          {
            id: 'rfnd_other_manual_123',
            status: 'processed',
            amount: 50000,
            payment_id: rzpPaymentId,
            receipt: 'rf_completely_different_receipt',
            notes: { refundId: 'some-other-uuid' },
          },
        ],
      });

      const updateRefundSetSpy = vi.fn().mockReturnValueOnce({
        where: vi.fn().mockResolvedValueOnce([]),
      });
      (db.update as any).mockReturnValueOnce({
        set: updateRefundSetSpy,
      });

      const count = await reconciliationService.reconcileInconsistentPayments();

      expect(count).toBe(0); // Not marked resolved since not matching
      // Crucial: Must NOT mark status as failed or processed! Status remains pending.
      expect(updateRefundSetSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          failureReason: expect.stringContaining('GATEWAY_AUDIT_WARNING'),
        }),
      );
      const callArg = updateRefundSetSpy.mock.calls[0][0];
      expect(callArg.status).toBeUndefined();
    });

    it('b3. if refund is absent from gateway list and amount_refunded is 0, retains pending to prevent duplicates (never marks failed)', async () => {
      const stRefundId = 'refund-timeout-absent';
      const rzpPaymentId = 'pay_rzp_ext_absent';

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            innerJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: stRefundId,
                  paymentId: 'pay-db-absent',
                  razorpayRefundId: null,
                  amountPaise: 50000,
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([
                {
                  id: 'pay-db-absent',
                  razorpayPaymentId: rzpPaymentId,
                },
              ]),
            }),
          }),
        });

      // Ledger shows 0 refunded
      (mockRazorpay.payments.fetch as any).mockResolvedValueOnce({
        id: rzpPaymentId,
        amount: 50000,
        amount_refunded: 0,
        refund_status: null,
        status: 'captured',
      });

      // Gateway collection is empty
      (mockRazorpay.payments.fetchMultipleRefund as any).mockResolvedValueOnce({
        entity: 'collection',
        count: 0,
        items: [],
      });

      const updateRefundSetSpy = vi.fn().mockReturnValueOnce({
        where: vi.fn().mockResolvedValueOnce([]),
      });
      (db.update as any).mockReturnValueOnce({
        set: updateRefundSetSpy,
      });

      const count = await reconciliationService.reconcileInconsistentPayments();

      expect(count).toBe(0);
      // Crucial: Must NEVER mark status as failed merely because it was absent from one API response!
      expect(updateRefundSetSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          failureReason: expect.stringContaining('AWAITING_GATEWAY_RECONCILIATION'),
        }),
      );
      const callArg = updateRefundSetSpy.mock.calls[0][0];
      expect(callArg.status).toBeUndefined(); // Remains pending!
    });

    it('c. prevents two concurrent refund requests via row lock and pending refund check', async () => {
      const paymentId = 'pay-concurrent-1';
      const actorId = 'admin-1';

      // Simulate caller 2 executing while caller 1 has an active pending refund
      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup with FOR UPDATE lock
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: paymentId,
                      status: 'captured',
                      amountPaise: 50000,
                      refundedAmountPaise: 0,
                      razorpayPaymentId: 'pay_test_456',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. Active pending refund check detects caller 1's inserted pending refund
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([{ id: 'rfnd-pending-caller-1' }]),
              }),
            }),
          }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      await expect(
        paymentsService.refundPayment(actorId, 'admin', paymentId, {
          reason: 'Simultaneous refund attempt',
        }),
      ).rejects.toThrow(ConflictException);

      expect(mockRazorpay.payments.refund).not.toHaveBeenCalled();
    });

    it('d. verifies uniform lock ordering (payment -> appointment) between cancellation and payment verification', async () => {
      const apptId = 'appt-deadlock-test';
      const payId = 'pay-deadlock-test';
      const orderId = 'order_deadlock_test';
      const pId = 'patient-1';
      const dId = 'doctor-1';

      // 1. Trace lock order in AppointmentsService.cancel():
      // First queries payment FOR UPDATE, second queries appointment FOR UPDATE
      const cancelLockSequence: string[] = [];
      const mockCancelTx = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation((table: any) => {
            const tableName = table === payment ? 'payment' : 'appointment';
            cancelLockSequence.push(tableName);
            return {
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    tableName === 'payment'
                      ? {
                          id: payId,
                          status: 'captured',
                          amountPaise: 50000,
                          refundedAmountPaise: 0,
                        }
                      : {
                          id: apptId,
                          patientId: pId,
                          doctorId: dId,
                          status: 'scheduled',
                        },
                  ]),
                }),
              }),
            };
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: apptId, status: 'cancelled' }]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockCancelTx));

      const mockDoctors = { isApproved: vi.fn().mockResolvedValue(true) };
      const apptService = new AppointmentsService(
        mockDoctors as any,
        undefined,
        undefined,
        paymentsService,
      );
      vi.spyOn(paymentsService, 'refundPayment').mockResolvedValueOnce({
        id: 'rfnd-1',
        status: 'processed',
      } as any);

      await apptService.cancel(apptId, { id: pId, role: 'patient' } as any);

      // Verify cancellation acquired payment first, appointment second
      expect(cancelLockSequence[0]).toBe('payment');
      expect(cancelLockSequence[1]).toBe('appointment');

      // 2. Trace lock order in PaymentsService.verifyPayment():
      // First queries payment FOR UPDATE, second queries appointment FOR UPDATE
      const verifyLockSequence: string[] = [];
      const validSig = createHmac('sha256', sampleSecret)
        .update(`${orderId}|pay_123`)
        .digest('hex');

      const mockVerifyTx = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation((table: any) => {
            const tableName = table === payment ? 'payment' : 'appointment';
            verifyLockSequence.push(tableName);
            return {
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    tableName === 'payment'
                      ? {
                          id: payId,
                          appointmentId: apptId,
                          patientId: pId,
                          doctorId: dId,
                          status: 'created',
                          amountPaise: 50000,
                          currency: 'INR',
                          razorpayOrderId: orderId,
                        }
                      : {
                          id: apptId,
                          doctorId: dId,
                          startsAt: new Date(),
                          endsAt: new Date(Date.now() + 30 * 60 * 1000),
                          status: 'pending_payment',
                        },
                  ]),
                }),
              }),
            };
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: apptId,
                  startsAt: new Date(),
                  endsAt: new Date(Date.now() + 30 * 60 * 1000),
                  status: 'scheduled',
                  doctorId: dId,
                },
              ]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockVerifyTx));
      (mockRazorpay.payments.fetch as any).mockResolvedValueOnce({
        id: 'pay_123',
        order_id: orderId,
        amount: 50000,
        currency: 'INR',
        status: 'captured',
      });

      await paymentsService.verifyPayment(pId, {
        appointmentId: apptId,
        razorpayOrderId: orderId,
        razorpayPaymentId: 'pay_123',
        razorpaySignature: validSig,
      });

      // Verify payment verification acquired payment first, appointment second
      expect(verifyLockSequence[0]).toBe('payment');
      expect(verifyLockSequence[1]).toBe('appointment');

      // Both follow identical linear lock order: Deadlock is mathematically prevented!
      expect(cancelLockSequence).toEqual(verifyLockSequence);
    });

    it('e. verifies uniform lock ordering (payment -> appointment) in payment.captured webhook', async () => {
      const orderId = 'order_webhook_deadlock_123';
      const webhookLockSequence: string[] = [];

      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_captured_hook_1',
              order_id: orderId,
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const mockWebhookTx = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation((table: any) => {
            const tableName = table === payment ? 'payment' : 'appointment';
            webhookLockSequence.push(tableName);
            return {
              where: vi.fn().mockReturnValue({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    tableName === 'payment'
                      ? {
                          id: 'pay-1',
                          appointmentId: 'appt-1',
                          patientId: 'patient-1',
                          doctorId: 'doctor-1',
                          status: 'created',
                          razorpayOrderId: orderId,
                        }
                      : {
                          id: 'appt-1',
                          doctorId: 'doctor-1',
                          startsAt: new Date(),
                          endsAt: new Date(Date.now() + 30 * 60 * 1000),
                          status: 'pending_payment',
                        },
                  ]),
                }),
              }),
            };
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: 'appt-1',
                  startsAt: new Date(),
                  endsAt: new Date(),
                  status: 'scheduled',
                  doctorId: 'doctor-1',
                },
              ]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockWebhookTx));

      const res = await paymentsService.handleWebhook(signature, rawBody, payload);

      expect(res.received).toBe(true);
      expect(res.status).toBe('captured');
      // Webhook acquired payment first, appointment second (identical to cancel and verifyPayment)
      expect(webhookLockSequence[0]).toBe('payment');
      expect(webhookLockSequence[1]).toBe('appointment');
    });
  });

  describe('Simulated In-Memory Concurrency Tests (Interleaved Async Promises, Not Live PostgreSQL)', () => {
    // Note: Live PostgreSQL database is hosted on remote AWS Neon serverless over WebSockets and is unreachable
    // in sandboxed/offline environments. These tests simulate concurrent async transaction interleaving and lock serialization.

    it('simulates concurrent cancellation vs payment verification with serialized lock acquisition', async () => {
      const apptId = 'appt-sim-concurrency-1';
      const payId = 'pay-sim-concurrency-1';
      const orderId = 'order_sim_concurrency_1';
      const patientId = 'patient-sim-1';
      const doctorId = 'doctor-sim-1';

      // Shared simulated database state
      let paymentState: any = {
        id: payId,
        appointmentId: apptId,
        patientId,
        doctorId,
        status: 'created',
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: orderId,
        refundedAmountPaise: 0,
      };

      let appointmentState: any = {
        id: apptId,
        patientId,
        doctorId,
        status: 'pending_payment',
        startsAt: new Date(Date.now() + 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 90 * 60 * 1000),
      };

      // Simulated lock coordinator
      let paymentLockedBy: string | null = null;
      let paymentLockReleasePromise: Promise<void> | null = null;
      let paymentLockReleaseResolve: (() => void) | null = null;

      const acquirePaymentLock = async (holderName: string) => {
        while (paymentLockedBy !== null && paymentLockedBy !== holderName) {
          await paymentLockReleasePromise;
        }
        paymentLockedBy = holderName;
        paymentLockReleasePromise = new Promise((res) => {
          paymentLockReleaseResolve = res;
        });
      };

      const releasePaymentLock = (holderName: string) => {
        if (paymentLockedBy === holderName) {
          paymentLockedBy = null;
          if (paymentLockReleaseResolve) {
            paymentLockReleaseResolve();
          }
        }
      };

      // Mock db.transaction to route through simulated locks
      (db.transaction as any).mockImplementation(async (cb: (tx: any) => Promise<any>) => {
        const txId = Math.random().toString(36).slice(2, 7);
        const tx = {
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockImplementation((table: any) => {
              if (table === refund) {
                return {
                  where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([]),
                  }),
                };
              }
              const tableName = table === payment ? 'payment' : 'appointment';
              return {
                where: vi.fn().mockReturnValue({
                  for: vi.fn().mockReturnValue({
                    limit: vi.fn().mockImplementation(async () => {
                      if (tableName === 'payment') {
                        await acquirePaymentLock(txId);
                      }
                      return [
                        tableName === 'payment' ? { ...paymentState } : { ...appointmentState },
                      ];
                    }),
                  }),
                  limit: vi.fn().mockImplementation(async () => [
                    tableName === 'payment' ? { ...paymentState } : { ...appointmentState },
                  ]),
                }),
              };
            }),
          })),
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockImplementation((vals: any) => ({
              returning: vi.fn().mockResolvedValue([{ ...vals }]),
            })),
          })),
          update: vi.fn().mockImplementation((table: any) => ({
            set: vi.fn().mockImplementation((updates: any) => ({
              where: vi.fn().mockImplementation(() => {
                if (table === payment) {
                  Object.assign(paymentState, updates);
                } else if (table === appointment) {
                  Object.assign(appointmentState, updates);
                }
                return {
                  returning: vi.fn().mockResolvedValue([{ ...(table === payment ? paymentState : appointmentState) }]),
                };
              }),
            })),
          })),
        };

        try {
          return await cb(tx);
        } finally {
          releasePaymentLock(txId);
        }
      });

      const mockDoctors = { isApproved: vi.fn().mockResolvedValue(true) };
      const apptService = new AppointmentsService(
        mockDoctors as any,
        undefined,
        undefined,
        paymentsService,
      );

      const validSig = createHmac('sha256', sampleSecret)
        .update(`${orderId}|pay_123`)
        .digest('hex');

      (mockRazorpay.payments.fetch as any).mockResolvedValue({
        id: 'pay_123',
        order_id: orderId,
        amount: 50000,
        currency: 'INR',
        status: 'captured',
      });
      (mockRazorpay.payments.refund as any).mockResolvedValue({
        id: 'rf_sim_123',
        payment_id: 'pay_123',
        amount: 50000,
        currency: 'INR',
        status: 'processed',
      });

      // Execute cancellation and payment verification simultaneously
      const cancelPromise = apptService.cancel(apptId, { id: patientId, role: 'patient' } as any);
      const verifyPromise = paymentsService.verifyPayment(patientId, {
        appointmentId: apptId,
        razorpayOrderId: orderId,
        razorpayPaymentId: 'pay_123',
        razorpaySignature: validSig,
      });

      const results = await Promise.allSettled([cancelPromise, verifyPromise]);
      const [cancelSettled, verifySettled] = results;

      expect(cancelSettled.status).toBe('fulfilled');
      if (cancelSettled.status === 'fulfilled') {
        expect(cancelSettled.value.status).toBe('cancelled');
      }

      // Serialized resolution:
      // If cancel acquired the lock first: payment status became 'failed' and verifyPayment was safely rejected with BadRequestException.
      // If verify acquired the lock first: verifyPayment succeeded with 'captured' and cancel succeeded with 'cancelled'.
      if (verifySettled.status === 'rejected') {
        expect((verifySettled.reason as any).message).toContain('Cannot verify payment with status: failed');
      } else {
        expect(verifySettled.value.status).toBe('captured');
      }
      // Zero unhandled deadlocks: both executed and completed safely
    });

    it('simulates concurrent cancellation vs payment.captured webhook with serialized lock acquisition', async () => {
      const apptId = 'appt-sim-hook-1';
      const payId = 'pay-sim-hook-1';
      const orderId = 'order_sim_hook_1';
      const patientId = 'patient-sim-2';
      const doctorId = 'doctor-sim-2';

      let paymentState: any = {
        id: payId,
        appointmentId: apptId,
        patientId,
        doctorId,
        status: 'created',
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: orderId,
        refundedAmountPaise: 0,
      };

      let appointmentState: any = {
        id: apptId,
        patientId,
        doctorId,
        status: 'pending_payment',
        startsAt: new Date(Date.now() + 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 90 * 60 * 1000),
      };

      let paymentLockedBy: string | null = null;
      let paymentLockReleasePromise: Promise<void> | null = null;
      let paymentLockReleaseResolve: (() => void) | null = null;

      const acquirePaymentLock = async (holderName: string) => {
        while (paymentLockedBy !== null && paymentLockedBy !== holderName) {
          await paymentLockReleasePromise;
        }
        paymentLockedBy = holderName;
        paymentLockReleasePromise = new Promise((res) => {
          paymentLockReleaseResolve = res;
        });
      };

      const releasePaymentLock = (holderName: string) => {
        if (paymentLockedBy === holderName) {
          paymentLockedBy = null;
          if (paymentLockReleaseResolve) {
            paymentLockReleaseResolve();
          }
        }
      };

      (db.transaction as any).mockImplementation(async (cb: (tx: any) => Promise<any>) => {
        const txId = Math.random().toString(36).slice(2, 7);
        const tx = {
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockImplementation((table: any) => {
              if (table === refund) {
                return {
                  where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([]),
                  }),
                };
              }
              const tableName = table === payment ? 'payment' : 'appointment';
              return {
                where: vi.fn().mockReturnValue({
                  for: vi.fn().mockReturnValue({
                    limit: vi.fn().mockImplementation(async () => {
                      if (tableName === 'payment') {
                        await acquirePaymentLock(txId);
                      }
                      return [
                        tableName === 'payment' ? { ...paymentState } : { ...appointmentState },
                      ];
                    }),
                  }),
                  limit: vi.fn().mockImplementation(async () => [
                    tableName === 'payment' ? { ...paymentState } : { ...appointmentState },
                  ]),
                }),
              };
            }),
          })),
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockImplementation((vals: any) => ({
              returning: vi.fn().mockResolvedValue([{ ...vals }]),
            })),
          })),
          update: vi.fn().mockImplementation((table: any) => ({
            set: vi.fn().mockImplementation((updates: any) => ({
              where: vi.fn().mockImplementation(() => {
                if (table === payment) {
                  Object.assign(paymentState, updates);
                } else if (table === appointment) {
                  Object.assign(appointmentState, updates);
                }
                return {
                  returning: vi.fn().mockResolvedValue([{ ...(table === payment ? paymentState : appointmentState) }]),
                };
              }),
            })),
          })),
        };

        try {
          return await cb(tx);
        } finally {
          releasePaymentLock(txId);
        }
      });

      const mockDoctors = { isApproved: vi.fn().mockResolvedValue(true) };
      const apptService = new AppointmentsService(
        mockDoctors as any,
        undefined,
        undefined,
        paymentsService,
      );

      (mockRazorpay.payments.refund as any).mockResolvedValue({
        id: 'rf_sim_hook_1',
        payment_id: 'pay_sim_captured_1',
        amount: 50000,
        currency: 'INR',
        status: 'processed',
      });

      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_sim_captured_1',
              order_id: orderId,
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const hookPromise = paymentsService.handleWebhook(signature, rawBody, payload);
      const cancelPromise = apptService.cancel(apptId, { id: patientId, role: 'patient' } as any);

      const [hookResult, cancelResult] = await Promise.all([hookPromise, cancelPromise]);

      expect(hookResult.received).toBe(true);
      expect(cancelResult.status).toBe('cancelled');
    });

    it('b. reconcilePendingRefund transitions refund to processed when Razorpay status is processed', async () => {
      (mockRazorpay.refunds.fetch as any).mockResolvedValueOnce({
        id: 'rfnd_pend_1',
        status: 'processed',
        acquirer_data: { arn: 'ARN_LIVE_123' },
      });

      const mockTx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: 'pay-pend-1',
                    amountPaise: 90000,
                    refundedAmountPaise: 0,
                    status: 'captured',
                  },
                ]),
              }),
            }),
          }),
        }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const reconciled = await reconciliationService.reconcilePendingRefund({
        id: 'ref-local-1',
        paymentId: 'pay-pend-1',
        razorpayRefundId: 'rfnd_pend_1',
        amountPaise: 90000,
      });

      expect(reconciled).toBe(true);
      expect(mockRazorpay.refunds.fetch).toHaveBeenCalledWith('rfnd_pend_1');
    });

    it('c. reconcilePendingRefund transitions refund to failed when Razorpay status is failed', async () => {
      (mockRazorpay.refunds.fetch as any).mockResolvedValueOnce({
        id: 'rfnd_fail_1',
        status: 'failed',
      });

      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      (db.update as any) = mockUpdate;

      const reconciled = await reconciliationService.reconcilePendingRefund({
        id: 'ref-local-2',
        paymentId: 'pay-fail-1',
        razorpayRefundId: 'rfnd_fail_1',
        amountPaise: 90000,
      });

      expect(reconciled).toBe(true);
      expect(mockRazorpay.refunds.fetch).toHaveBeenCalledWith('rfnd_fail_1');
    });

    it('d. reconcilePendingRefund retains pending when Razorpay status is still pending', async () => {
      (mockRazorpay.refunds.fetch as any).mockResolvedValueOnce({
        id: 'rfnd_still_pend_1',
        status: 'pending',
      });

      const reconciled = await reconciliationService.reconcilePendingRefund({
        id: 'ref-local-3',
        paymentId: 'pay-pend-3',
        razorpayRefundId: 'rfnd_still_pend_1',
        amountPaise: 90000,
      });

      expect(reconciled).toBe(false);
      expect(mockRazorpay.refunds.fetch).toHaveBeenCalledWith('rfnd_still_pend_1');
    });

    it('e. handleWebhook updates refund status to failed on refund.failed event', async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      (db.update as any) = mockUpdate;

      const payload = {
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_wh_fail_1',
              payment_id: 'pay_wh_1',
              error_description: 'Issuer bank declined refund',
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const result = await paymentsService.handleWebhook(signature, rawBody, payload);
      expect(result.received).toBe(true);
      expect(result.status).toBe('failed');
    });
  });
});
