import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, inArray, or } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import {
  loadAssistantTestEnvironment,
  validateTestTarget,
  verifyTestDatabase,
} from '../scripts/verify-assistant-test-db.mjs';
import {
  appointment,
  appointmentReminder,
  doctorProfile,
  emailOutbox,
  payment,
  refund,
  user,
} from '../src/db/schema.js';
import { RAZORPAY_TOKEN } from '../src/payments/razorpay.provider.js';
import { PaymentsController } from '../src/payments/payments.controller.js';
import { AppointmentsService } from '../src/appointments/appointments.service.js';
import { AppointmentExpiryService } from '../src/appointments/appointment-expiry.service.js';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service.js';

describe('Razorpay Signed Webhook HTTP Integration Tests (Phase 2D-3)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let database: typeof import('../src/db/database.js');
  let paymentsController: PaymentsController;
  let appointmentsService: AppointmentsService;

  const testWebhookSecret = 'whsec_test_audit_32_characters_long_webhook!';
  const testKeySecret = 'rzp_sec_test_audit_32_chars_key_secret!';

  // Track created fixtures for teardown
  const createdUserIds: string[] = [];
  const createdDoctorProfileIds: string[] = [];
  const createdAppointmentIds: string[] = [];
  const createdPaymentIds: string[] = [];
  const createdRefundIds: string[] = [];

  let testDoctorUserId: string;
  let testPatientUserId: string;
  let testDoctorProfileId: string;

  const rejectRazorpay = vi.fn(async () => {
    throw new Error('Unexpected remote Razorpay API call in webhook integration test.');
  });

  const mockRazorpay = {
    orders: {
      create: rejectRazorpay,
    },
    payments: {
      fetch: rejectRazorpay,
      refund: vi.fn().mockImplementation(async (paymentId: string, params: { amount: number; notes?: Record<string, string> }) => ({
        id: `rfnd_mock_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
        entity: 'refund',
        amount: params.amount,
        currency: 'INR',
        payment_id: paymentId,
        status: 'processed',
        acquirer_data: { arn: 'ARN_MOCK_123456789' },
      })),
    },
    refunds: {
      fetch: rejectRazorpay,
    },
  };

  function computeHmacSignature(rawBody: Buffer | string, secret = testWebhookSecret): string {
    return createHmac('sha256', secret).update(rawBody).digest('hex');
  }

  function signedWebhookRequest(payload: unknown, secret = testWebhookSecret, rawBodyOverride?: string) {
    const rawBody = rawBodyOverride ?? JSON.stringify(payload);
    const signature = computeHmacSignature(rawBody, secret);
    return http
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', signature)
      .set('Content-Type', 'application/json')
      .send(rawBody);
  }

  function sessionCookie(headers: { [key: string]: unknown }) {
    const cookies = headers['set-cookie'];
    if (!Array.isArray(cookies) || !cookies.length) throw new Error('Better Auth did not set a session cookie.');
    return cookies.map((cookie: string) => cookie.split(';', 1)[0]).join('; ');
  }

  async function createAdminUser() {
    const credentials = {
      email: `webhook-admin-${randomUUID()}@example.test`,
      name: 'Webhook Admin Fixture',
      password: randomUUID(),
    };
    const response = await http.post('/api/auth/sign-up/email').send(credentials).expect(200);
    const id: string = response.body.user.id;
    createdUserIds.push(id);
    await database.db.update(user).set({ role: 'admin' }).where(eq(user.id, id));
    const login = await http.post('/api/auth/sign-in/email').send(credentials).expect(200);
    return { id, credentials, cookie: sessionCookie(login.headers) };
  }

  beforeAll(async () => {
    // 1. Confirm test target using validateTestTarget() and verifyTestDatabase()
    const env = loadAssistantTestEnvironment();
    const target = validateTestTarget(env);
    await verifyTestDatabase(env);
    console.log(`Verified webhook HTTP test database ${target.database} at ${target.host}.`);

    // 2. Set environment variables to isolated test database and test credentials
    for (const [key, value] of Object.entries({
      DATABASE_URL: target.connectionString,
      BETTER_AUTH_URL: 'http://127.0.0.1:5000',
      FRONTEND_URL: 'http://127.0.0.1:3000',
      BETTER_AUTH_SECRET: randomUUID(),
      EMAIL_DELIVERY_MODE: 'disabled',
      EMAIL_TEST_RECIPIENT: undefined,
      RESEND_API_KEY: undefined,
      RAZORPAY_KEY_ID: 'rzp_test_webhook_audit',
      RAZORPAY_KEY_SECRET: testKeySecret,
      RAZORPAY_WEBHOOK_SECRET: testWebhookSecret,
    })) {
      vi.stubEnv(key, value);
    }

    // 3. Dynamically import database module to bind to the test target
    database = await import('../src/db/database.js');

    // 4. Suppress startup cron sweeps to isolate webhook execution
    vi.spyOn(AppointmentExpiryService.prototype, 'onModuleInit').mockResolvedValue();
    vi.spyOn(PaymentReconciliationService.prototype, 'onModuleInit').mockResolvedValue();

    // 5. Bootstrap testing module with real AppModule and mocked Razorpay provider
    const { AppModule } = await import('../src/app.module.js');
    const { registerAuthHandler } = await import('../src/auth/auth-handler.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RAZORPAY_TOKEN)
      .useValue(mockRazorpay)
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
    const server = app.getHttpAdapter().getInstance();
    registerAuthHandler(server);

    // Ensure rawBody is captured on incoming requests as in main.ts
    server.use(
      express.json({
        verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );

    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());

    paymentsController = app.get(PaymentsController);
    appointmentsService = app.get(AppointmentsService);

    // 6. Seed fixture doctor and patient accounts
    testDoctorUserId = randomUUID();
    testPatientUserId = randomUUID();
    createdUserIds.push(testDoctorUserId, testPatientUserId);

    await database.db.insert(user).values([
      {
        id: testDoctorUserId,
        name: 'Dr. Webhook Fixture Doctor',
        email: `webhook-doctor-${randomUUID()}@example.test`,
        emailVerified: true,
        role: 'doctor',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: testPatientUserId,
        name: 'Webhook Fixture Patient',
        email: `webhook-patient-${randomUUID()}@example.test`,
        emailVerified: true,
        role: 'patient',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    testDoctorProfileId = randomUUID();
    createdDoctorProfileIds.push(testDoctorProfileId);

    await database.db.insert(doctorProfile).values({
      id: testDoctorProfileId,
      userId: testDoctorUserId,
      specialty: 'Internal Medicine',
      licenseRegion: 'Delhi',
      licenseNumber: `WH-DOC-${Date.now()}`,
      consultationFeeInr: 500, // 50000 paise
      status: 'approved',
      reviewedAt: new Date(),
      reviewedBy: testDoctorUserId,
      bio: 'Webhook test doctor',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    const failures: string[] = [];

    try {
      await app?.close();
    } catch {
      failures.push('app close');
    }

    try {
      if (database?.db) {
        const { db } = database;

        if (createdPaymentIds.length) {
          await db.delete(refund).where(inArray(refund.paymentId, createdPaymentIds));
        }

        if (createdRefundIds.length) {
          await db.delete(refund).where(inArray(refund.id, createdRefundIds));
        }

        if (createdPaymentIds.length) {
          await db.delete(payment).where(inArray(payment.id, createdPaymentIds));
        }

        if (createdAppointmentIds.length) {
          await db.delete(appointmentReminder).where(inArray(appointmentReminder.appointmentId, createdAppointmentIds));
          await db.delete(emailOutbox).where(inArray(emailOutbox.appointmentId, createdAppointmentIds));
          await db.delete(appointment).where(inArray(appointment.id, createdAppointmentIds));
        }

        if (createdDoctorProfileIds.length) {
          await db.delete(doctorProfile).where(inArray(doctorProfile.id, createdDoctorProfileIds));
        }

        if (createdUserIds.length) {
          await db.delete(user).where(inArray(user.id, createdUserIds));
        }
      }
    } catch (err) {
      console.error('Fixture cleanup error:', err);
      failures.push(`fixture cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await database?.pool.end();
    } catch {
      failures.push('database pool close');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }

    if (failures.length) {
      throw new Error(`Webhook HTTP cleanup encountered failures (${failures.join(', ')}).`);
    }
  });

  // --- 1. Valid signed payment.captured webhook ---
  it('1. processes valid signed payment.captured webhook and updates payment + appointment in DB', async () => {
    const apptId = randomUUID();
    const payId = randomUUID();
    const orderId = `order_wh_valid_${randomUUID().slice(0, 8)}`;
    const rzpPaymentId = `pay_wh_valid_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(payId);

    const startsAt = new Date(Date.now() + 86400_000); // Tomorrow
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'pending_payment',
      holdExpiresAt: new Date(Date.now() + 600_000),
    });

    await database.db.insert(payment).values({
      id: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: orderId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
      receipt: `rcpt_${payId.slice(0, 10)}`,
      refundedAmountPaise: 0,
    });

    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rzpPaymentId,
            order_id: orderId,
            amount: 50000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    };

    const res = await signedWebhookRequest(payload).expect(200);
    expect(res.body.received).toBe(true);
    expect(res.body.status).toBe('captured');

    // Verify DB state
    const [updatedPayment] = await database.db.select().from(payment).where(eq(payment.id, payId));
    expect(updatedPayment.status).toBe('captured');
    expect(updatedPayment.razorpayPaymentId).toBe(rzpPaymentId);

    const [updatedAppt] = await database.db.select().from(appointment).where(eq(appointment.id, apptId));
    expect(updatedAppt.status).toBe('scheduled');
    expect(updatedAppt.holdExpiresAt).toBeNull();
  });

  // --- 2. Invalid signature ---
  it('2. rejects webhook with invalid signature with HTTP 400 and makes no DB mutations', async () => {
    const apptId = randomUUID();
    const payId = randomUUID();
    const orderId = `order_wh_bad_sig_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(payId);

    const startsAt = new Date(Date.now() + 90000_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'pending_payment',
      holdExpiresAt: new Date(Date.now() + 600_000),
    });

    await database.db.insert(payment).values({
      id: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: orderId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
      receipt: `rcpt_${payId.slice(0, 10)}`,
      refundedAmountPaise: 0,
    });

    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_fake_${randomUUID().slice(0, 8)}`,
            order_id: orderId,
            amount: 50000,
            currency: 'INR',
          },
        },
      },
    };

    const forgedSignature = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    await http
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', forgedSignature)
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(payload)))
      .expect(400);

    // Verify DB state remains unchanged
    const [storedPayment] = await database.db.select().from(payment).where(eq(payment.id, payId));
    expect(storedPayment.status).toBe('created');
    expect(storedPayment.razorpayPaymentId).toBeNull();

    const [storedAppt] = await database.db.select().from(appointment).where(eq(appointment.id, apptId));
    expect(storedAppt.status).toBe('pending_payment');
  });

  // --- 3. Missing rawBody ---
  it('3. explicitly rejects webhook request when rawBody is missing without falling back to JSON.stringify', async () => {
    // A: Test via HTTP request bypassing body parser (e.g. text/plain or missing body buffer)
    const forgedSig = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';

    const res = await http
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', forgedSig)
      .set('Content-Type', 'text/plain')
      .send('plain text body')
      .expect(400);

    expect(res.body.message).toContain('Missing request raw body');

    // B: Test controller directly with synthetic req missing rawBody
    const mockReqWithoutRawBody = { rawBody: undefined } as any;
    expect(() =>
      paymentsController.handleWebhook('valid_signature_dummy', mockReqWithoutRawBody, { event: 'payment.captured' }),
    ).toThrow('Missing request raw body for webhook verification.');
  });

  // --- 4. Duplicate payment.captured ---
  it('4. safely handles duplicate payment.captured idempotently without duplicate side effects', async () => {
    const apptId = randomUUID();
    const payId = randomUUID();
    const orderId = `order_wh_dup_${randomUUID().slice(0, 8)}`;
    const rzpPaymentId = `pay_wh_dup_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(payId);

    const startsAt = new Date(Date.now() + 100000_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'pending_payment',
      holdExpiresAt: new Date(Date.now() + 600_000),
    });

    await database.db.insert(payment).values({
      id: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: orderId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
      receipt: `rcpt_${payId.slice(0, 10)}`,
      refundedAmountPaise: 0,
    });

    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rzpPaymentId,
            order_id: orderId,
            amount: 50000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    };

    // First delivery -> captures
    const res1 = await signedWebhookRequest(payload).expect(200);
    expect(res1.body.received).toBe(true);
    expect(res1.body.status).toBe('captured');

    const outboxAfterFirst = await database.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.appointmentId, apptId));
    const firstOutboxCount = outboxAfterFirst.length;

    // Second delivery -> idempotent replay
    const res2 = await signedWebhookRequest(payload).expect(200);
    expect(res2.body.received).toBe(true);
    expect(res2.body.note).toBe('Already captured.');

    const outboxAfterSecond = await database.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.appointmentId, apptId));
    expect(outboxAfterSecond.length).toBe(firstOutboxCount);

    const [finalPayment] = await database.db.select().from(payment).where(eq(payment.id, payId));
    expect(finalPayment.status).toBe('captured');

    const [finalAppt] = await database.db.select().from(appointment).where(eq(appointment.id, apptId));
    expect(finalAppt.status).toBe('scheduled');
  });

  // --- 5. payment.failed after captured ---
  it('5. ignores payment.failed when payment is already captured and does not downgrade to failed', async () => {
    const apptId = randomUUID();
    const payId = randomUUID();
    const orderId = `order_wh_fail_after_cap_${randomUUID().slice(0, 8)}`;
    const rzpPaymentId = `pay_wh_fail_after_cap_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(payId);

    const startsAt = new Date(Date.now() + 110000_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'scheduled',
    });

    await database.db.insert(payment).values({
      id: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: orderId,
      razorpayPaymentId: rzpPaymentId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
      receipt: `rcpt_${payId.slice(0, 10)}`,
      refundedAmountPaise: 0,
    });

    const failedPayload = {
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: `pay_failed_attempt_${randomUUID().slice(0, 8)}`,
            order_id: orderId,
            error_description: 'Late decline notification from network',
          },
        },
      },
    };

    const res = await signedWebhookRequest(failedPayload).expect(200);
    expect(res.body.received).toBe(true);
    expect(res.body.status).toBe('failed');

    // Crucial check: DB record must remain 'captured'
    const [storedPayment] = await database.db.select().from(payment).where(eq(payment.id, payId));
    expect(storedPayment.status).toBe('captured');
    expect(storedPayment.failureReason).toBeNull();
  });

  // --- 6. Amount and currency mismatch ---
  it('6. rejects payment.captured when amount or currency does not match stored payment order', async () => {
    const apptId = randomUUID();
    const payId = randomUUID();
    const orderId = `order_wh_mismatch_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(payId);

    const startsAt = new Date(Date.now() + 120000_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'pending_payment',
      holdExpiresAt: new Date(Date.now() + 600_000),
    });

    await database.db.insert(payment).values({
      id: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: orderId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
      receipt: `rcpt_${payId.slice(0, 10)}`,
      refundedAmountPaise: 0,
    });

    // 6a: Amount mismatch
    const amountMismatchPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_amt_bad_${randomUUID().slice(0, 8)}`,
            order_id: orderId,
            amount: 99999, // Mismatched: expected 50000
            currency: 'INR',
          },
        },
      },
    };

    const resAmt = await signedWebhookRequest(amountMismatchPayload).expect(200);
    expect(resAmt.body.received).toBe(true);
    expect(resAmt.body.note).toBe('Payment amount mismatch. Webhook ignored.');

    const [payAfterAmt] = await database.db.select().from(payment).where(eq(payment.id, payId));
    expect(payAfterAmt.status).toBe('created');

    const [apptAfterAmt] = await database.db.select().from(appointment).where(eq(appointment.id, apptId));
    expect(apptAfterAmt.status).toBe('pending_payment');

    // 6b: Currency mismatch
    const currencyMismatchPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_curr_bad_${randomUUID().slice(0, 8)}`,
            order_id: orderId,
            amount: 50000,
            currency: 'USD', // Mismatched: expected INR
          },
        },
      },
    };

    const resCurr = await signedWebhookRequest(currencyMismatchPayload).expect(200);
    expect(resCurr.body.received).toBe(true);
    expect(resCurr.body.note).toBe('Payment currency mismatch. Webhook ignored.');

    const [payAfterCurr] = await database.db.select().from(payment).where(eq(payment.id, payId));
    expect(payAfterCurr.status).toBe('created');

    const [apptAfterCurr] = await database.db.select().from(appointment).where(eq(appointment.id, apptId));
    expect(apptAfterCurr.status).toBe('pending_payment');
  });

  // --- 7. Late capture for cancelled past appointment ---
  it('7. routes late captured payment for cancelled past appointment into refund reconciliation flow without resurrecting appointment', async () => {
    const apptId = randomUUID();
    const payId = randomUUID();
    const orderId = `order_wh_late_past_${randomUUID().slice(0, 8)}`;
    const rzpPaymentId = `pay_wh_late_past_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(payId);

    // Slot was 2 hours ago and is cancelled
    const startsAt = new Date(Date.now() - 7200_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'cancelled',
      holdExpiresAt: null,
    });

    await database.db.insert(payment).values({
      id: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: orderId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
      receipt: `rcpt_${payId.slice(0, 10)}`,
      refundedAmountPaise: 0,
    });

    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rzpPaymentId,
            order_id: orderId,
            amount: 50000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    };

    const res = await signedWebhookRequest(payload).expect(200);
    expect(res.body.received).toBe(true);
    expect(res.body.status).toBe('captured');
    expect(res.body.note).toBe('Slot reassigned, refund queued');

    // Appointment must NEVER be resurrected to scheduled
    const [storedAppt] = await database.db.select().from(appointment).where(eq(appointment.id, apptId));
    expect(storedAppt.status).toBe('cancelled');

    // Payment must be marked captured with failure reason for reconciliation
    const [storedPayment] = await database.db.select().from(payment).where(eq(payment.id, payId));
    expect(storedPayment.status).toBe('captured');
    expect(storedPayment.failureReason).toBe('Slot reassigned after hold expiry. Queued for refund/reconciliation.');

    // Poll for background reconcileLatePayment call to complete
    let createdRefund;
    for (let i = 0; i < 15; i++) {
      [createdRefund] = await database.db.select().from(refund).where(eq(refund.paymentId, payId));
      if (createdRefund) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    // Verify refund record was queued/created in DB
    expect(createdRefund).toBeDefined();
    if (createdRefund) {
      createdRefundIds.push(createdRefund.id);
      expect(createdRefund.amountPaise).toBe(50000);
    }
  });

  // --- 8. refund.failed after refund processed ---
  it('8. ignores refund.failed when refund is already processed and prevents backward status transition', async () => {
    const apptId = randomUUID();
    const payId = randomUUID();
    const refundId = randomUUID();
    const rzpRefundId = `rfnd_processed_${randomUUID().slice(0, 8)}`;
    const rzpPaymentId = `pay_for_rfnd_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(payId);
    createdRefundIds.push(refundId);

    const startsAt = new Date(Date.now() + 130000_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'cancelled',
    });

    await database.db.insert(payment).values({
      id: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: `order_for_rfnd_${randomUUID().slice(0, 8)}`,
      razorpayPaymentId: rzpPaymentId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'refunded',
      receipt: `rcpt_${payId.slice(0, 10)}`,
      refundedAmountPaise: 50000,
    });

    await database.db.insert(refund).values({
      id: refundId,
      paymentId: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayPaymentId: rzpPaymentId,
      razorpayRefundId: rzpRefundId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'processed',
      reason: 'Patient cancellation refund',
      arn: 'ARN_INITIAL_PROCESSED',
    });

    const refundFailedPayload = {
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: rzpRefundId,
            payment_id: rzpPaymentId,
            error_description: 'Issuing bank reversed settlement failure',
          },
        },
      },
    };

    const res = await signedWebhookRequest(refundFailedPayload).expect(200);
    expect(res.body.received).toBe(true);
    expect(res.body.status).toBe('failed');

    // Crucial check: Refund in DB must STILL be 'processed'
    const [storedRefund] = await database.db.select().from(refund).where(eq(refund.id, refundId));
    expect(storedRefund.status).toBe('processed');
    expect(storedRefund.failureReason).toBeNull();
  });

  // --- 9. SEC-2D-01: Multi-payment cancellation regression test ---
  it('9. selects captured payment for refund and marks created holds as failed during cancellation', async () => {
    const apptId = randomUUID();
    const pay1FailedId = randomUUID();
    const pay2CapturedId = randomUUID();
    const pay3CreatedId = randomUUID();
    const rzpPaymentId = `pay_captured_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(pay1FailedId, pay2CapturedId, pay3CreatedId);

    const startsAt = new Date(Date.now() + 140000_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    // Insert scheduled appointment
    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'scheduled',
    });

    // Insert three payments:
    // 1. Older failed attempt
    // 2. Captured payment
    // 3. Newer created hold
    await database.db.insert(payment).values([
      {
        id: pay1FailedId,
        appointmentId: apptId,
        patientId: testPatientUserId,
        doctorId: testDoctorUserId,
        razorpayOrderId: `order_failed_${randomUUID().slice(0, 8)}`,
        razorpayPaymentId: `pay_failed_${randomUUID().slice(0, 8)}`,
        amountPaise: 50000,
        currency: 'INR',
        status: 'failed',
        receipt: `rcpt_${pay1FailedId.slice(0, 10)}`,
        createdAt: new Date(Date.now() - 3600_000),
      },
      {
        id: pay2CapturedId,
        appointmentId: apptId,
        patientId: testPatientUserId,
        doctorId: testDoctorUserId,
        razorpayOrderId: `order_captured_${randomUUID().slice(0, 8)}`,
        razorpayPaymentId: rzpPaymentId,
        amountPaise: 50000,
        currency: 'INR',
        status: 'captured',
        receipt: `rcpt_${pay2CapturedId.slice(0, 10)}`,
        createdAt: new Date(Date.now() - 1800_000),
      },
      {
        id: pay3CreatedId,
        appointmentId: apptId,
        patientId: testPatientUserId,
        doctorId: testDoctorUserId,
        razorpayOrderId: `order_created_${randomUUID().slice(0, 8)}`,
        amountPaise: 50000,
        currency: 'INR',
        status: 'created',
        receipt: `rcpt_${pay3CreatedId.slice(0, 10)}`,
        createdAt: new Date(Date.now() - 600_000),
      },
    ]);

    // Cancel appointment via AppointmentsService
    await appointmentsService.cancel(
      apptId,
      {
        id: testPatientUserId,
        email: 'webhook-patient@example.test',
        name: 'Webhook Fixture Patient',
        role: 'patient',
      },
      'Patient requested cancellation',
    );

    // Verify appointment is cancelled
    const [storedAppt] = await database.db.select().from(appointment).where(eq(appointment.id, apptId));
    expect(storedAppt.status).toBe('cancelled');

    // Verify refund was created specifically for the captured payment (Payment 2)
    const refunds = await database.db.select().from(refund).where(eq(refund.paymentId, pay2CapturedId));
    expect(refunds).toHaveLength(1);
    const [createdRefund] = refunds;
    createdRefundIds.push(createdRefund.id);
    expect(createdRefund.amountPaise).toBe(50000);
    expect(createdRefund.status).toBe('processed');

    // Verify Payment 2 status is refunded
    const [storedPay2] = await database.db.select().from(payment).where(eq(payment.id, pay2CapturedId));
    expect(storedPay2.status).toBe('refunded');
    expect(storedPay2.refundedAmountPaise).toBe(50000);

    // Verify Payment 1 remains failed
    const [storedPay1] = await database.db.select().from(payment).where(eq(payment.id, pay1FailedId));
    expect(storedPay1.status).toBe('failed');

    // Verify Payment 3 (created hold) was batch-marked failed by SEC-2D-01 fix
    const [storedPay3] = await database.db.select().from(payment).where(eq(payment.id, pay3CreatedId));
    expect(storedPay3.status).toBe('failed');
    expect(storedPay3.failureReason).toContain('cancellation');
  });

  // --- 10. SEC-2D-02: Concurrent late capture vs booking slot resurrection race ---
  it('10. serializes late capture slot resurrection and new booking with doctor-slot advisory lock', async () => {
    // Slot in future within doctor's standard schedule (Monday 11:30 IST / 06:00 UTC)
    const startsAt = new Date('2032-06-07T06:00:00.000Z');
    const endsAt = new Date('2032-06-07T06:30:00.000Z');

    // Patient A's cancelled appointment and late capture payment
    const apptAId = randomUUID();
    const payAId = randomUUID();
    const rzpOrderIdA = `order_late_${randomUUID().slice(0, 8)}`;
    const rzpPaymentIdA = `pay_late_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptAId);
    createdPaymentIds.push(payAId);

    await database.db.insert(appointment).values({
      id: apptAId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'cancelled',
    });

    await database.db.insert(payment).values({
      id: payAId,
      appointmentId: apptAId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: rzpOrderIdA,
      razorpayPaymentId: rzpPaymentIdA,
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
      receipt: `rcpt_${payAId.slice(0, 10)}`,
    });

    // Seed Patient B
    const patientBUserId = randomUUID();
    createdUserIds.push(patientBUserId);

    await database.db.insert(user).values({
      id: patientBUserId,
      name: 'Concurrent Patient B',
      email: `webhook-patient-b-${randomUUID()}@example.test`,
      emailVerified: true,
      role: 'patient',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Run late capture webhook and Patient B booking concurrently
    const lateCaptureTask = signedWebhookRequest({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rzpPaymentIdA,
            order_id: rzpOrderIdA,
            amount: 50000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    const bookingTask = appointmentsService.createForPatient(patientBUserId, {
      doctorProfileId: testDoctorProfileId,
      startsAt,
      endsAt,
    });

    const [_webhookResult, bookingResult] = await Promise.allSettled([lateCaptureTask, bookingTask]);

    // Check results: Neither crashed with an unhandled 500 or 23P01 error
    if (bookingResult.status === 'fulfilled') {
      createdAppointmentIds.push(bookingResult.value.id);
    }

    // Verify DB state: Exactly ONE appointment owns this doctor's slot in scheduled or pending_payment status
    const activeAppts = await database.db
      .select({ id: appointment.id, status: appointment.status, patientId: appointment.patientId })
      .from(appointment)
      .where(
        and(
          eq(appointment.doctorId, testDoctorUserId),
          eq(appointment.startsAt, startsAt),
          or(eq(appointment.status, 'scheduled'), eq(appointment.status, 'pending_payment')),
        ),
      );

    expect(activeAppts).toHaveLength(1);

    // Verify the losing flow was safely handled without conflict crash
    if (bookingResult.status === 'fulfilled') {
      // Patient B won the slot -> Patient A's late capture was routed to refund reconciliation
      expect(activeAppts[0].patientId).toBe(patientBUserId);
      const [payRecordA] = await database.db.select().from(payment).where(eq(payment.id, payAId));
      expect(payRecordA.failureReason).toContain('Slot reassigned after hold expiry');
    } else {
      // Patient A's late capture won -> Patient A's appt was resurrected to scheduled; Patient B received ConflictException
      expect(activeAppts[0].patientId).toBe(testPatientUserId);
      expect(activeAppts[0].status).toBe('scheduled');
      expect(bookingResult.status).toBe('rejected');
      expect((bookingResult as PromiseRejectedResult).reason?.message).toContain('already has a scheduled appointment');
    }
  });

  // --- 11. Admin refund concurrency test ---
  it('11. serializes concurrent admin refund requests and prevents duplicate refunds or over-refund', async () => {
    const admin = await createAdminUser();

    const apptId = randomUUID();
    const payId = randomUUID();
    const rzpPaymentId = `pay_admin_rfnd_${randomUUID().slice(0, 8)}`;

    createdAppointmentIds.push(apptId);
    createdPaymentIds.push(payId);

    const startsAt = new Date(Date.now() + 150000_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await database.db.insert(appointment).values({
      id: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      startsAt,
      endsAt,
      status: 'cancelled',
    });

    await database.db.insert(payment).values({
      id: payId,
      appointmentId: apptId,
      patientId: testPatientUserId,
      doctorId: testDoctorUserId,
      razorpayOrderId: `order_admin_rfnd_${randomUUID().slice(0, 8)}`,
      razorpayPaymentId: rzpPaymentId,
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
      receipt: `rcpt_${payId.slice(0, 10)}`,
      refundedAmountPaise: 0,
    });

    // Fire two simultaneous admin refund requests for the full amount
    const req1 = http
      .post(`/api/admin/payments/${payId}/refund`)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Admin refund request A' });

    const req2 = http
      .post(`/api/admin/payments/${payId}/refund`)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Admin refund request B' });

    const [res1, res2] = await Promise.all([req1, req2]);

    const statuses = [res1.status, res2.status].sort();
    // One succeeds (200), the losing request receives 409 (in-progress) or 400 (already fully refunded)
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);

    // Check DB state: Exactly one refund row created
    const refunds = await database.db.select().from(refund).where(eq(refund.paymentId, payId));
    expect(refunds).toHaveLength(1);
    createdRefundIds.push(refunds[0].id);
    expect(refunds[0].amountPaise).toBe(50000);

    // Check Payment: No over-refund!
    const [storedPayment] = await database.db.select().from(payment).where(eq(payment.id, payId));
    expect(storedPayment.refundedAmountPaise).toBe(50000);
  });
});
