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

function mockTransactionWithSelectResults(results: unknown[]) {
  const builders: Array<{ for: ReturnType<typeof vi.fn> }> = [];
  const tx = {
    select: vi.fn(() => {
      const result = results.shift() ?? [];
      const builder: any = {};
      for (const method of ['from', 'where', 'limit']) builder[method] = vi.fn(() => builder);
      builder.for = vi.fn(() => builder);
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      builders.push(builder);
      return builder;
    }),
    update: vi.fn(),
  };
  return { tx, builders };
}

function updateReturning(result: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function updateCompleting() {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) };
}

describe('PaymentsService', () => {
  let service: PaymentsService;
  let mockRazorpay: RazorpayInstance;
  let mockNotifications: any;

  const sampleSecret = 'sample_test_secret_32_chars_long!!';
  const sampleWebhookSecret = 'sample_test_webhook_secret_32_c!!';

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/test';
    process.env.BETTER_AUTH_URL = 'http://localhost:5000';
    process.env.FRONTEND_URL = 'http://localhost:3000';
    process.env.BETTER_AUTH_SECRET = 'sample_secret_must_be_32_characters_minimum!';
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

      mockTx.select.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ for: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status: 'scheduled' }]) }) }) }) });

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

    it.each([
      { status: 'cancelled', reason: 'Slot reassigned after hold expiry. Queued for refund/reconciliation.', late: true },
      { status: 'scheduled', reason: 'Slot reassigned after hold expiry. Queued for refund/reconciliation.', late: true },
      { status: 'cancelled', reason: null, late: false },
    ])('does not confirm a captured replay when appointment is $status and late=$late', async ({ status, reason, late }) => {
      const signature = createHmac('sha256', sampleSecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
      const chain = (rows: unknown[]) => ({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ for: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }) }) });
      const mockTx = { select: vi.fn().mockReturnValueOnce(chain([{ id: 'pay-1', appointmentId, patientId, razorpayOrderId, status: 'captured', failureReason: reason }])).mockReturnValueOnce(chain([{ status }])), update: vi.fn() };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));
      const result = await service.verifyPayment(patientId, { appointmentId, razorpayOrderId, razorpayPaymentId, razorpaySignature: signature });
      expect(result).toMatchObject({ success: false, lateCapture: late, status: 'captured' });
      if (late) expect(result.message).toContain('refund has been queued');
      expect(mockTx.update).not.toHaveBeenCalled();
      expect(mockRazorpay.payments.fetch).not.toHaveBeenCalled();
      expect(mockNotifications.createNotification).not.toHaveBeenCalled();
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

    it('refunds late capture only when capacity is full and takes the shared doctor capacity lock', async () => {
      const validSignature = createHmac('sha256', sampleSecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      const { tx: mockTx, builders } = mockTransactionWithSelectResults([
        [{ id: 'pay-1', appointmentId, patientId, doctorId: 'doctor-1', razorpayOrderId,
          amountPaise: 50000, currency: 'INR', status: 'failed', failureReason: 'Hold expired before payment completion' }],
        [{ id: appointmentId, doctorId: 'doctor-1', startsAt: new Date(Date.now() + 86400000), endsAt: new Date(Date.now() + 88200000), status: 'cancelled' }],
        [{}], // shared doctor capacity lock
        [{ capacity: 1 }], // weekly capacity
        [], // no date override
        [{ id: 'other-appt' }], // the only capacity place is occupied
      ]);
      mockTx.update.mockReturnValueOnce(updateCompleting());

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
      expect(builders[2]?.for).toHaveBeenCalledWith('update');
    });

    it('accepts a late capture when a multi-capacity slot still has room', async () => {
      const validSignature = createHmac('sha256', sampleSecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');
      const scheduledAppointment = {
        id: appointmentId, patientId, doctorId: 'doctor-1', startsAt: new Date(Date.now() + 86400000),
        endsAt: new Date(Date.now() + 88200000), status: 'scheduled', updatedAt: new Date(), reminderGeneration: 0,
      };
      const { tx } = mockTransactionWithSelectResults([
        [{ id: 'pay-1', appointmentId, patientId, doctorId: 'doctor-1', razorpayOrderId,
          amountPaise: 50000, currency: 'INR', status: 'failed', failureReason: 'Hold expired before payment completion' }],
        [{ id: appointmentId, doctorId: 'doctor-1', startsAt: scheduledAppointment.startsAt, endsAt: scheduledAppointment.endsAt, status: 'cancelled' }],
        [{}],
        [{ capacity: 3 }], // wave/stream slot capacity
        [],
        [{ id: 'one-active-booking' }], // one booking leaves two places available
      ]);
      tx.update
        .mockReturnValueOnce(updateCompleting())
        .mockReturnValueOnce(updateReturning([scheduledAppointment]));
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(tx));

      const result = await service.verifyPayment(patientId, {
        appointmentId, razorpayOrderId, razorpayPaymentId, razorpaySignature: validSignature,
      });

      expect(result.success).toBe(true);
      expect(result.lateCapture).toBeUndefined();
      expect(tx.update).toHaveBeenCalledTimes(2);
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
                      startsAt: new Date(Date.now() + 86400000),
                      endsAt: new Date(Date.now() + 88200000),
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
                    startsAt: new Date(Date.now() + 86400000),
                    endsAt: new Date(Date.now() + 88200000),
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

  describe('Concurrency and Deadlock Hardening (SEC-01)', () => {
    it('withDeadlockRetry retries on 40P01 deadlock and succeeds on subsequent attempt', async () => {
      let attempts = 0;
      const result = await service.withDeadlockRetry(async () => {
        attempts++;
        if (attempts === 1) {
          const err: any = new Error('deadlock detected');
          err.code = '40P01';
          throw err;
        }
        return 'success_after_retry';
      }, 2, 5);

      expect(attempts).toBe(2);
      expect(result).toBe('success_after_retry');
    });

    it('withDeadlockRetry retries on 40001 serialization failure and succeeds', async () => {
      let attempts = 0;
      const result = await service.withDeadlockRetry(async () => {
        attempts++;
        if (attempts === 1) {
          const err: any = new Error('could not serialize access due to read/write dependencies');
          err.code = '40001';
          throw err;
        }
        return 'success_serialization';
      }, 2, 5);

      expect(attempts).toBe(2);
      expect(result).toBe('success_serialization');
    });

    it('withDeadlockRetry throws after exhausting max retries', async () => {
      let attempts = 0;
      await expect(
        service.withDeadlockRetry(async () => {
          attempts++;
          const err: any = new Error('deadlock detected');
          err.code = '40P01';
          throw err;
        }, 2, 5),
      ).rejects.toMatchObject({ code: '40P01' });

      expect(attempts).toBe(3); // 1 initial + 2 retries
    });

    it('withDeadlockRetry does not retry on unrelated errors', async () => {
      let attempts = 0;
      await expect(
        service.withDeadlockRetry(async () => {
          attempts++;
          throw new BadRequestException('Invalid parameter');
        }, 2, 5),
      ).rejects.toThrow(BadRequestException);

      expect(attempts).toBe(1);
    });

    it('safely handles late capture race when concurrent webhook already captured payment', async () => {
      const orderId = 'order_webhook_race';
      const paymentId = 'pay_webhook_race';
      const appointmentId = 'appt_webhook_race';
      const signature = createHmac('sha256', sampleSecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const mockTx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    id: 'pay-db-1',
                    appointmentId,
                    patientId: 'patient-123',
                    razorpayOrderId: orderId,
                    status: 'captured', // already captured by webhook
                  },
                ]),
              }),
            }),
          }),
        }),
        update: vi.fn(),
      };

      mockTx.select.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ for: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status: 'scheduled' }]) }) }) }) });

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await service.verifyPayment('patient-123', {
        appointmentId,
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('captured');
      expect(result.message).toBe('Payment has already been processed.');
      expect(mockTx.update).not.toHaveBeenCalled();
    });
  });

  describe('Phase 2D-2 Webhook State Regression and Validation Fixes', () => {
    it('payment.failed only updates payments with status created and ignores already-captured payments', async () => {
      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_fail_created_check',
              order_id: 'order_test_created_only',
              error_description: 'Card expired',
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const mockWhere = vi.fn().mockResolvedValueOnce([]);
      const mockSet = vi.fn().mockReturnValueOnce({ where: mockWhere });
      (db.update as any).mockReturnValueOnce({ set: mockSet });

      const res = await service.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.status).toBe('failed');
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          failureReason: 'Card expired',
        }),
      );
      expect(mockWhere).toHaveBeenCalled();
    });

    it('refund.failed only updates refunds with status pending and ignores already-processed refunds', async () => {
      const payload = {
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_fail_test',
              payment_id: 'pay_test_for_rfnd',
              error_description: 'Refund failed by issuing bank',
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const mockWhere = vi.fn().mockResolvedValueOnce([]);
      const mockSet = vi.fn().mockReturnValueOnce({ where: mockWhere });
      (db.update as any).mockReturnValueOnce({ set: mockSet });

      const res = await service.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.status).toBe('failed');
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          failureReason: 'Refund failed by issuing bank',
        }),
      );
      expect(mockWhere).toHaveBeenCalled();
    });

    it('rejects/ignores payment.captured webhook when amount does not match stored payment order', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_amt_mismatch',
              order_id: 'order_amt_mismatch',
              amount: 99999, // Mismatch: stored is 50000
              currency: 'INR',
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
                    id: 'pay-mismatch-1',
                    appointmentId: 'appt-mismatch-1',
                    patientId: 'pat-1',
                    doctorId: 'doc-1',
                    amountPaise: 50000,
                    currency: 'INR',
                    status: 'created',
                  },
                ]),
              }),
            }),
          }),
        }),
        update: vi.fn(),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const res = await service.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.note).toBe('Payment amount mismatch. Webhook ignored.');
      expect(mockTx.update).not.toHaveBeenCalled();
    });

    it('rejects/ignores payment.captured webhook when currency does not match stored payment order', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_curr_mismatch',
              order_id: 'order_curr_mismatch',
              amount: 50000,
              currency: 'USD', // Mismatch: stored is INR
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
                    id: 'pay-curr-1',
                    appointmentId: 'appt-curr-1',
                    patientId: 'pat-1',
                    doctorId: 'doc-1',
                    amountPaise: 50000,
                    currency: 'INR',
                    status: 'created',
                  },
                ]),
              }),
            }),
          }),
        }),
        update: vi.fn(),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const res = await service.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.note).toBe('Payment currency mismatch. Webhook ignored.');
      expect(mockTx.update).not.toHaveBeenCalled();
    });

    it('routes late captured webhook for past cancelled appointment into refund reconciliation flow', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_late_past_webhook',
              order_id: 'order_late_past',
              amount: 50000,
              currency: 'INR',
            },
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', sampleWebhookSecret).update(rawBody).digest('hex');

      const reconcileSpy = vi.spyOn(service, 'reconcileLatePayment').mockResolvedValue(undefined as any);

      const pastStartsAt = new Date(Date.now() - 3600_000); // 1 hour ago
      const pastEndsAt = new Date(Date.now() - 1800_000);

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment row
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'pay-late-id-1',
                      appointmentId: 'appt-late-past-1',
                      patientId: 'pat-late-1',
                      doctorId: 'doc-late-1',
                      amountPaise: 50000,
                      currency: 'INR',
                      status: 'created',
                      razorpayPaymentId: null,
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. Appointment row (cancelled, slot in the past)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'appt-late-past-1',
                      doctorId: 'doc-late-1',
                      startsAt: pastStartsAt,
                      endsAt: pastEndsAt,
                      status: 'cancelled',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 3. Email recipients
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([
                { id: 'pat-late-1', name: 'Late Patient', email: 'late@example.invalid' },
                { id: 'doc-late-1', name: 'Dr. Test', email: 'dr@example.invalid' },
              ]),
            }),
          }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const res = await service.handleWebhook(signature, rawBody, payload);
      expect(res.received).toBe(true);
      expect(res.status).toBe('captured');
      expect(res.note).toBe('Slot reassigned, refund queued');
      expect(reconcileSpy).toHaveBeenCalledWith('pay-late-id-1');
      // Verify appointment was NOT updated to scheduled
      expect(mockTx.update).toHaveBeenCalledTimes(1); // Only payment updated to captured with failureReason
    });

    it('verifyPayment routes late capture for past cancelled appointment into refund reconciliation flow', async () => {
      const orderId = 'order_test_123';
      const paymentId = 'pay_test_456';
      const appointmentId = 'appt_late_past_verify';
      const signature = createHmac('sha256', sampleSecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const pastStartsAt = new Date(Date.now() - 3600_000);
      const pastEndsAt = new Date(Date.now() - 1800_000);

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment row
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'pay-late-verify-1',
                      appointmentId,
                      patientId: 'patient-late-verify',
                      doctorId: 'doctor-1',
                      razorpayOrderId: orderId,
                      amountPaise: 50000,
                      currency: 'INR',
                      status: 'created',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 2. Appointment row
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: appointmentId,
                      doctorId: 'doctor-1',
                      startsAt: pastStartsAt,
                      endsAt: pastEndsAt,
                      status: 'cancelled',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 3. Email recipients
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([
                { id: 'patient-late-verify', name: 'Patient', email: 'pat@example.invalid' },
                { id: 'doctor-1', name: 'Doctor', email: 'doc@example.invalid' },
              ]),
            }),
          }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await service.verifyPayment('patient-late-verify', {
        appointmentId,
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      });

      expect(result.success).toBe(false);
      expect(result.lateCapture).toBe(true);
      expect(result.status).toBe('captured');
      expect(result.message).toContain('appointment hold expired');
      // Only payment updated with refund reason; appointment is NOT scheduled
      expect(mockTx.update).toHaveBeenCalledTimes(1);
    });
  });
});
