import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PaymentsService } from './payments.service.js';
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

describe('PaymentsService', () => {
  let service: PaymentsService;
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
        create: vi.fn().mockResolvedValue({
          id: 'order_test_123',
          amount: 50000,
          currency: 'INR',
          status: 'created',
          receipt: 'rcpt_test',
        }),
      },
      payments: {
        fetch: vi.fn().mockResolvedValue({
          id: 'pay_test_456',
          order_id: 'order_test_123',
          amount: 50000,
          currency: 'INR',
          status: 'captured',
        }),
      },
    };

    mockNotifications = {
      createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
    };

    service = new PaymentsService(mockRazorpay, mockNotifications);
  });

  describe('Cryptographic Signature Verification', () => {
    it('verifies a valid checkout HMAC-SHA256 signature', () => {
      const orderId = 'order_9A33XWu170gUtm';
      const paymentId = 'pay_29QQoUBi66xm2f';
      const signature = createHmac('sha256', sampleSecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const isValid = service.verifyHmacSignature(orderId, paymentId, signature, sampleSecret);
      expect(isValid).toBe(true);
    });

    it('rejects a tampered signature', () => {
      const orderId = 'order_9A33XWu170gUtm';
      const paymentId = 'pay_29QQoUBi66xm2f';
      const tamperedSignature = '0000000000000000000000000000000000000000000000000000000000000000';

      const isValid = service.verifyHmacSignature(orderId, paymentId, tamperedSignature, sampleSecret);
      expect(isValid).toBe(false);
    });

    it('verifies a valid webhook raw payload HMAC signature', () => {
      const rawBody = JSON.stringify({ event: 'payment.captured', data: { id: '123' } });
      const signature = createHmac('sha256', sampleWebhookSecret)
        .update(rawBody)
        .digest('hex');

      const isValid = service.verifyWebhookHmac(rawBody, signature, sampleWebhookSecret);
      expect(isValid).toBe(true);
    });
  });

  describe('createOrder', () => {
    const patientId = 'patient-uuid-1';
    const appointmentId = '00000000-0000-4000-8000-000000000001';

    it('rejects order generation if appointment is not found', async () => {
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([]),
          }),
        }),
      });

      await expect(service.createOrder(patientId, { appointmentId })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects order generation if caller is not the appointment owner', async () => {
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([
              {
                id: appointmentId,
                patientId: 'different-patient',
                doctorId: 'doctor-1',
                status: 'pending_payment',
              },
            ]),
          }),
        }),
      });

      await expect(service.createOrder(patientId, { appointmentId })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects order generation if appointment is already scheduled', async () => {
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([
              {
                id: appointmentId,
                patientId,
                doctorId: 'doctor-1',
                status: 'scheduled',
              },
            ]),
          }),
        }),
      });

      await expect(service.createOrder(patientId, { appointmentId })).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects order generation and cancels appointment if hold expired', async () => {
      const expiredHold = new Date(Date.now() - 60_000); // 1 minute in the past
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([
              {
                id: appointmentId,
                patientId,
                doctorId: 'doctor-1',
                status: 'pending_payment',
                holdExpiresAt: expiredHold,
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

      await expect(service.createOrder(patientId, { appointmentId })).rejects.toThrow(
        BadRequestException,
      );
      expect(db.update).toHaveBeenCalled(); // auto-cancelled to free slot
    });

    it('reuses existing active order idempotently to prevent duplicate orders', async () => {
      // 1. Appointment select
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([
              {
                id: appointmentId,
                patientId,
                doctorId: 'doctor-1',
                status: 'pending_payment',
                holdExpiresAt: new Date(Date.now() + 600_000),
              },
            ]),
          }),
        }),
      });

      // 2. Doctor consultation fee select
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([{ consultationFeeInr: 500 }]),
          }),
        }),
      });

      // 3. Existing payment check: found active order with status 'created'
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([
              {
                id: 'pay-rec-1',
                appointmentId,
                razorpayOrderId: 'order_existing_123',
                amountPaise: 50000,
                currency: 'INR',
                status: 'created',
              },
            ]),
          }),
        }),
      });

      const result = await service.createOrder(patientId, { appointmentId });
      expect(result.orderId).toBe('order_existing_123');
      expect(result.amountPaise).toBe(50000);
      expect(mockRazorpay.orders.create).not.toHaveBeenCalled(); // avoided duplicate external API call
    });

    it('successfully creates order and records payment with integer amount in paise', async () => {
      // 1. Appointment select
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([
              {
                id: appointmentId,
                patientId,
                doctorId: 'doctor-1',
                status: 'pending_payment',
                holdExpiresAt: new Date(Date.now() + 600_000),
              },
            ]),
          }),
        }),
      });

      // 2. Doctor consultation fee select (INR 650 -> 65000 paise)
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([{ consultationFeeInr: 650 }]),
          }),
        }),
      });

      // 3. Existing payment check: none
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([]),
          }),
        }),
      });

      // 4. DB insert payment
      (db.insert as any).mockReturnValueOnce({
        values: vi.fn().mockResolvedValueOnce([]),
      });

      const result = await service.createOrder(patientId, { appointmentId });
      expect(result.orderId).toBe('order_test_123');
      expect(result.amountPaise).toBe(65000); // 650 * 100
      expect(result.currency).toBe('INR');
      expect(mockRazorpay.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 65000,
          currency: 'INR',
        }),
      );
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('verifyPayment', () => {
    const patientId = 'patient-uuid-1';
    const appointmentId = '00000000-0000-4000-8000-000000000001';
    const razorpayOrderId = 'order_test_123';
    const razorpayPaymentId = 'pay_test_456';

    it('rejects an invalid HMAC signature before touching the database', async () => {
      await expect(
        service.verifyPayment(patientId, {
          appointmentId,
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature: 'invalid-signature-hex',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns success idempotently if payment is already captured', async () => {
      const validSignature = createHmac('sha256', sampleSecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      const mockTx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: 'pay-1',
                    appointmentId,
                    patientId,
                    razorpayOrderId,
                    status: 'captured',
                  },
                ]),
              }),
            }),
          }),
        }),
        update: vi.fn(),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await service.verifyPayment(patientId, {
        appointmentId,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature: validSignature,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('captured');
      expect(mockTx.update).not.toHaveBeenCalled();
    });

    it('successfully confirms payment, schedules appointment and emits notifications', async () => {
      const reminderScheduler = { scheduleForAppointment: vi.fn().mockResolvedValue(4) };
      const scheduleService = { getTimezoneForDoctor: vi.fn().mockResolvedValue('America/New_York') };
      service = new PaymentsService(mockRazorpay, mockNotifications, undefined, scheduleService as never, reminderScheduler as never);
      const validSignature = createHmac('sha256', sampleSecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      const mockAppt = {
        id: appointmentId,
        startsAt: new Date('2026-11-05T10:00:00+05:30'),
        endsAt: new Date('2026-11-05T10:30:00+05:30'),
        status: 'scheduled',
        doctorId: 'doctor-1',
        patientId,
        updatedAt: new Date(),
        reminderGeneration: 0,
      };

      const mockTx = {
        select: vi
          .fn()
          // 1. payment select
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'pay-1',
                      appointmentId,
                      patientId,
                      doctorId: 'doctor-1',
                      razorpayOrderId,
                      amountPaise: 50000,
                      currency: 'INR',
                      status: 'created',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. appointment select
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: appointmentId,
                      doctorId: 'doctor-1',
                      startsAt: mockAppt.startsAt,
                      endsAt: mockAppt.endsAt,
                      status: 'pending_payment',
                    },
                  ]),
                }),
              }),
            }),
          }),
        update: vi
          .fn()
          // 1. payment update
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          })
          // 2. appointment update
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                returning: vi.fn().mockResolvedValueOnce([mockAppt]),
              }),
            }),
          }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await service.verifyPayment(patientId, {
        appointmentId,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature: validSignature,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('captured');
      expect(mockRazorpay.payments.fetch).toHaveBeenCalledWith(razorpayPaymentId);
      expect(mockNotifications.createNotification).toHaveBeenCalledTimes(2); // patient & doctor
      expect(reminderScheduler.scheduleForAppointment).toHaveBeenCalledWith(mockTx, expect.objectContaining({ reminderGeneration: 0 }), 'America/New_York');
    });

    it('safely handles late capture when slot was reassigned and queues a refund', async () => {
      const validSignature = createHmac('sha256', sampleSecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      const mockTx = {
        select: vi
          .fn()
          // 1. payment select: status was failed due to expiry
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'pay-1',
                      appointmentId,
                      patientId,
                      doctorId: 'doctor-1',
                      razorpayOrderId,
                      amountPaise: 50000,
                      currency: 'INR',
                      status: 'failed',
                      failureReason: 'Hold expired before payment completion',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. appointment select: appointment was cancelled
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: appointmentId,
                      doctorId: 'doctor-1',
                      startsAt: new Date('2026-11-05T10:00:00Z'),
                      endsAt: new Date('2026-11-05T10:30:00Z'),
                      status: 'cancelled',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 3. conflict check: another patient booked the slot!
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([{ id: 'other-appt' }]),
              }),
            }),
          }),
        update: vi.fn().mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockResolvedValueOnce([]),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await service.verifyPayment(patientId, {
        appointmentId,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature: validSignature,
      });

      expect(result.success).toBe(false);
      expect(result.lateCapture).toBe(true);
      expect(result.status).toBe('captured');
      expect(result.message).toContain('refund has been queued');
      expect(mockNotifications.createNotification).toHaveBeenCalled();
    });
  });

  describe('handleWebhook', () => {
    it('rejects requests with invalid signature', async () => {
      await expect(
        service.handleWebhook('invalid-sig', '{"event":"payment.captured"}', { event: 'payment.captured' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('idempotently updates payment on payment.captured event', async () => {
      const mockEmailOutbox = { enqueue: vi.fn().mockResolvedValue(undefined) };
      const mockScheduleService = { getTimezoneForDoctor: vi.fn().mockResolvedValue('America/New_York') };
      const reminders = { scheduleForAppointment: vi.fn().mockResolvedValue(4) };
      service = new PaymentsService(mockRazorpay, mockNotifications, mockEmailOutbox as never, mockScheduleService as never, reminders as never);
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_test_789',
              order_id: 'order_test_123',
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const mockTx = {
        select: vi
          .fn()
          // 1. payment select
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'pay-1',
                      appointmentId: 'appt-1',
                      patientId: 'pat-1',
                      doctorId: 'doc-1',
                      status: 'created',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. appointment select
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'appt-1',
                      doctorId: 'doc-1',
                      startsAt: new Date('2026-11-05T10:00:00Z'),
                      endsAt: new Date('2026-11-05T10:30:00Z'),
                      status: 'pending_payment',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 3. Fetch email recipients for transactional outbox enqueue
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([
                { id: 'pat-1', name: 'Test Patient', email: 'patient@example.invalid' },
                { id: 'doc-1', name: 'Test Doctor', email: 'doctor@example.invalid' },
              ]),
            }),
          }),
        update: vi
          .fn()
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          })
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                returning: vi.fn().mockResolvedValueOnce([
                  {
                    id: 'appt-1',
                    startsAt: new Date('2026-11-05T10:00:00Z'),
                    endsAt: new Date('2026-11-05T10:30:00Z'),
                    status: 'scheduled',
                    doctorId: 'doc-1',
                    patientId: 'pat-1',
                    updatedAt: new Date(),
                    reminderGeneration: 0,
                  },
                ]),
              }),
            }),
          }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const res = await service.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.status).toBe('captured');
      expect(mockEmailOutbox.enqueue).toHaveBeenCalledTimes(3);
      expect(reminders.scheduleForAppointment).toHaveBeenCalledWith(mockTx, expect.objectContaining({ reminderGeneration: 0 }), 'America/New_York');
      expect(mockEmailOutbox.enqueue).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({ payload: expect.objectContaining({ timezone: 'America/New_York' }) }),
      );
      expect(mockNotifications.createNotification.mock.calls.map(([notification]) => notification.message).join(' ')).toContain('(America/New_York)');

      const duplicateTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: 'pay-1',
                  appointmentId: 'appt-1',
                  patientId: 'pat-1',
                  doctorId: 'doc-1',
                  status: 'captured',
                }]),
              }),
            }),
          }),
        }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(duplicateTx));
      const duplicate = await service.handleWebhook(signature, rawBody, payload);
      expect(duplicate.note).toBe('Already captured.');
      expect(mockEmailOutbox.enqueue).toHaveBeenCalledTimes(3);
      expect(reminders.scheduleForAppointment).toHaveBeenCalledTimes(1);
    });

    it('records failure description on payment.failed event', async () => {
      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_fail_789',
              order_id: 'order_test_123',
              error_description: 'Payment was declined by bank due to insufficient funds',
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

      const res = await service.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.status).toBe('failed');
      expect(db.update).toHaveBeenCalled();
    });
  });
});
