import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { RAZORPAY_TOKEN } from '../src/payments/razorpay.provider.js';
import { AuthSessionGuard } from '../src/auth/auth-session.guard.js';
import { RolesGuard } from '../src/auth/roles.guard.js';
import { REQUIRED_ROLES } from '../src/auth/roles.decorator.js';
import { db } from '../src/db/database.js';
import { appointment, doctorProfile, payment, refund, user } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { AppointmentExpiryService } from '../src/appointments/appointment-expiry.service.js';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service.js';

describe('Payments & Slot Booking E2E Integration Audit', () => {
  let app: INestApplication;
  let expiryService: AppointmentExpiryService;
  let reconciliationService: PaymentReconciliationService;

  const testSecret = 'test_razorpay_secret_for_e2e_auditing!';
  const testWebhookSecret = 'test_webhook_secret_for_e2e_auditing!';

  // Simulated authenticated users
  let patientUser: { id: string; email: string; name: string };
  let unauthorizedPatientUser: { id: string; email: string; name: string };
  let doctorUser: { id: string; email: string; name: string };
  let adminUser: { id: string; email: string; name: string };
  let doctorProfileRecord: { id: string; userId: string };

  let activeDoctorProfileId: string;
  let activeAppointmentId: string;
  let activeOrderId = 'order_e2e_mock_123';
  let activePaymentId = 'pay_e2e_mock_456';
  let createdPaymentRecordId: string;

  const mockRazorpayClient = {
    orders: {
      create: vi.fn().mockImplementation(async (params: any) => ({
        id: activeOrderId,
        amount: params.amount,
        currency: params.currency,
        status: 'created',
        receipt: params.receipt,
      })),
    },
    payments: {
      fetch: vi.fn().mockImplementation(async (id: string) => ({
        id,
        order_id: activeOrderId,
        amount: 50000,
        currency: 'INR',
        status: 'captured',
      })),
      refund: vi.fn().mockImplementation(async (paymentId: string, params: any) => ({
        id: paymentId === activePaymentId ? 'rfnd_e2e_mock_123' : `rfnd_e2e_${paymentId.slice(0, 8)}_${Date.now()}`,
        entity: 'refund',
        amount: params.amount,
        currency: 'INR',
        payment_id: paymentId,
        status: 'processed',
        acquirer_data: { arn: 'ARN_E2E_789456' },
        receipt: params.receipt,
      })),
    },
    refunds: {
      fetch: vi.fn().mockImplementation(async (refundId: string) => ({
        id: refundId,
        entity: 'refund',
        amount: 50000,
        currency: 'INR',
        payment_id: activePaymentId,
        status: 'processed',
        acquirer_data: { arn: 'ARN_E2E_789456' },
      })),
    },
  };

  beforeAll(async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_e2eaudit';
    process.env.RAZORPAY_KEY_SECRET = testSecret;
    process.env.RAZORPAY_WEBHOOK_SECRET = testWebhookSecret;

    // Seed test users in DB if not existing
    patientUser = {
      id: randomUUID(),
      email: `patient_${Date.now()}@e2etest.com`,
      name: 'E2E Patient User',
    };
    unauthorizedPatientUser = {
      id: randomUUID(),
      email: `intruder_${Date.now()}@e2etest.com`,
      name: 'Intruder Patient User',
    };
    doctorUser = {
      id: randomUUID(),
      email: `doctor_${Date.now()}@e2etest.com`,
      name: 'Dr. E2E Specialist',
    };
    adminUser = {
      id: randomUUID(),
      email: `admin_${Date.now()}@e2etest.com`,
      name: 'E2E Admin User',
    };

    await db.insert(user).values([
      {
        id: patientUser.id,
        name: patientUser.name,
        email: patientUser.email,
        emailVerified: true,
        role: 'patient',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: unauthorizedPatientUser.id,
        name: unauthorizedPatientUser.name,
        email: unauthorizedPatientUser.email,
        emailVerified: true,
        role: 'patient',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: doctorUser.id,
        name: doctorUser.name,
        email: doctorUser.email,
        emailVerified: true,
        role: 'doctor',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: adminUser.id,
        name: adminUser.name,
        email: adminUser.email,
        emailVerified: true,
        role: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    activeDoctorProfileId = randomUUID();
    const [insertedProfile] = await db
      .insert(doctorProfile)
      .values({
        id: activeDoctorProfileId,
        userId: doctorUser.id,
        specialty: 'Cardiology',
        licenseRegion: 'Maharashtra',
        licenseNumber: `DOC-${Date.now()}`,
        consultationFeeInr: 500, // 500 INR -> 50000 paise
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: doctorUser.id,
        bio: 'E2E verified cardiologist',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    doctorProfileRecord = insertedProfile;

    const reflector = new Reflector();

    // Build Nest module
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RAZORPAY_TOKEN)
      .useValue(mockRazorpayClient)
      .overrideGuard(AuthSessionGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          const authHeader = req.headers['x-test-user-id'];
          const callerId = authHeader ?? patientUser.id;
          const callerRole =
            req.headers['x-test-user-role'] ??
            (callerId === adminUser.id ? 'admin' : callerId === doctorUser.id ? 'doctor' : 'patient');

          const userObj = {
            id: callerId,
            role: callerRole,
            email:
              callerId === adminUser.id
                ? adminUser.email
                : callerId === unauthorizedPatientUser.id
                  ? unauthorizedPatientUser.email
                  : patientUser.email,
            name:
              callerId === adminUser.id
                ? adminUser.name
                : callerId === unauthorizedPatientUser.id
                  ? unauthorizedPatientUser.name
                  : patientUser.name,
          };
          req.authUser = userObj;
          req.user = userObj;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: (context: any) => {
          const requiredRoles = reflector.getAllAndOverride<string[]>(REQUIRED_ROLES, [
            context.getHandler(),
            context.getClass(),
          ]);
          if (!requiredRoles?.length) {
            return true;
          }
          const req = context.switchToHttp().getRequest();
          const user = req.authUser ?? req.user;
          return Boolean(user && requiredRoles.includes(user.role));
        },
      })
      .compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    const express = (await import('express')).default;
    app.use(
      express.json({
        verify: (req: any, _res: any, buf: Buffer) => {
          req.rawBody = buf;
        },
      }),
    );
    await app.init();
    expiryService = app.get(AppointmentExpiryService);
    reconciliationService = app.get(PaymentReconciliationService);
  });

  afterAll(async () => {
    // Clean up created records
    try {
      if (activeAppointmentId) {
        await db.delete(refund).where(eq(refund.appointmentId, activeAppointmentId));
        await db.delete(payment).where(eq(payment.appointmentId, activeAppointmentId));
        await db.delete(appointment).where(eq(appointment.id, activeAppointmentId));
      }
      if (doctorProfileRecord?.id) {
        await db.delete(doctorProfile).where(eq(doctorProfile.id, doctorProfileRecord.id));
      }
      await db.delete(user).where(eq(user.id, patientUser.id));
      await db.delete(user).where(eq(user.id, unauthorizedPatientUser.id));
      await db.delete(user).where(eq(user.id, doctorUser.id));
      await db.delete(user).where(eq(user.id, adminUser.id));
    } catch {}

    if (app) {
      await app.close();
    }
  });

  it('1. Patient books a slot -> atomic 10-minute hold in pending_payment state', async () => {
    // Mon Nov 15 2027 at 10:00 IST (04:30 UTC)
    const startsAt = '2027-11-15T04:30:00.000Z';
    const endsAt = '2027-11-15T05:00:00.000Z';

    const res = await request(app.getHttpServer())
      .post('/api/appointments')
      .set('x-test-user-id', patientUser.id)
      .send({
        doctorProfileId: activeDoctorProfileId,
        startsAt,
        endsAt,
      })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.holdExpiresAt).toBeDefined();

    activeAppointmentId = res.body.id;
  });

  it('2. Slot exclusion constraint prevents another patient from booking the held slot', async () => {
    const startsAt = '2027-11-15T04:30:00.000Z';
    const endsAt = '2027-11-15T05:00:00.000Z';

    await request(app.getHttpServer())
      .post('/api/appointments')
      .set('x-test-user-id', unauthorizedPatientUser.id)
      .send({
        doctorProfileId: activeDoctorProfileId,
        startsAt,
        endsAt,
      })
      .expect(409);
  });

  it('3. Generates server-side Razorpay order and creates payment record', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/payments/create-order')
      .set('x-test-user-id', patientUser.id)
      .send({ appointmentId: activeAppointmentId })
      .expect(201);

    expect(res.body.orderId).toBe(activeOrderId);
    expect(res.body.amountPaise).toBe(50000); // 500 INR = 50000 paise
    expect(res.body.currency).toBe('INR');

    const [dbPay] = await db
      .select()
      .from(payment)
      .where(eq(payment.appointmentId, activeAppointmentId));
    expect(dbPay).toBeDefined();
    expect(dbPay.status).toBe('created');
    createdPaymentRecordId = dbPay.id;
  });

  it('4. Rejects create-order attempt by unauthorized user', async () => {
    await request(app.getHttpServer())
      .post('/api/payments/create-order')
      .set('x-test-user-id', unauthorizedPatientUser.id)
      .send({ appointmentId: activeAppointmentId })
      .expect(403);
  });

  it('5. Rejects payment verification with invalid HMAC-SHA256 signature', async () => {
    await request(app.getHttpServer())
      .post('/api/payments/verify')
      .set('x-test-user-id', patientUser.id)
      .send({
        appointmentId: activeAppointmentId,
        razorpayOrderId: activeOrderId,
        razorpayPaymentId: activePaymentId,
        razorpaySignature: 'invalid_tampered_signature_hex_code_123',
      })
      .expect(400);
  });

  it('6. Successfully verifies payment with valid HMAC signature and updates status', async () => {
    const validSignature = createHmac('sha256', testSecret)
      .update(`${activeOrderId}|${activePaymentId}`)
      .digest('hex');

    const res = await request(app.getHttpServer())
      .post('/api/payments/verify')
      .set('x-test-user-id', patientUser.id)
      .send({
        appointmentId: activeAppointmentId,
        razorpayOrderId: activeOrderId,
        razorpayPaymentId: activePaymentId,
        razorpaySignature: validSignature,
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('captured');

    const [updatedAppt] = await db
      .select()
      .from(appointment)
      .where(eq(appointment.id, activeAppointmentId));
    expect(updatedAppt.status).toBe('scheduled');
    expect(updatedAppt.holdExpiresAt).toBeNull();

    const [updatedPay] = await db
      .select()
      .from(payment)
      .where(eq(payment.appointmentId, activeAppointmentId));
    expect(updatedPay.status).toBe('captured');
  });

  it('7. Payment verification is idempotent on duplicate submissions', async () => {
    const validSignature = createHmac('sha256', testSecret)
      .update(`${activeOrderId}|${activePaymentId}`)
      .digest('hex');

    const res = await request(app.getHttpServer())
      .post('/api/payments/verify')
      .set('x-test-user-id', patientUser.id)
      .send({
        appointmentId: activeAppointmentId,
        razorpayOrderId: activeOrderId,
        razorpayPaymentId: activePaymentId,
        razorpaySignature: validSignature,
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('already been processed');
  });

  it('8. Cannot create a new order for an already scheduled appointment', async () => {
    await request(app.getHttpServer())
      .post('/api/payments/create-order')
      .set('x-test-user-id', patientUser.id)
      .send({ appointmentId: activeAppointmentId })
      .expect(409);
  });

  it('9. Handles webhook payment.captured event idempotently', async () => {
    const webhookPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: activePaymentId,
            order_id: activeOrderId,
            amount: 50000,
            status: 'captured',
          },
        },
      },
    };
    const rawBody = JSON.stringify(webhookPayload);
    const signature = createHmac('sha256', testWebhookSecret).update(rawBody).digest('hex');

    const res = await request(app.getHttpServer())
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', signature)
      .set('Content-Type', 'application/json')
      .send(webhookPayload)
      .expect(200);

    expect(res.body.received).toBe(true);
  });

  it('10. Rejects webhook requests with invalid or missing HMAC signatures', async () => {
    await request(app.getHttpServer())
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', 'invalid_sig_here')
      .send({ event: 'payment.captured' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/payments/webhook')
      .send({ event: 'payment.captured' })
      .expect(400);
  });

  it('11. Background expiry cron cancels expired unpaid holds and frees the slot', async () => {
    const [expiredAppt] = await db
      .insert(appointment)
      .values({
        id: randomUUID(),
        patientId: patientUser.id,
        doctorId: doctorUser.id,
        startsAt: new Date('2027-11-15T06:00:00.000Z'),
        endsAt: new Date('2027-11-15T06:30:00.000Z'),
        status: 'pending_payment',
        holdExpiresAt: new Date(Date.now() - 30_000), // 30 seconds ago
      })
      .returning();

    const [expiredPay] = await db
      .insert(payment)
      .values({
        id: randomUUID(),
        appointmentId: expiredAppt.id,
        patientId: patientUser.id,
        doctorId: doctorUser.id,
        razorpayOrderId: 'order_expired_sweep_1',
        amountPaise: 50000,
        currency: 'INR',
        status: 'created',
        receipt: 'rcpt_expired_sweep_1',
        refundedAmountPaise: 0,
      })
      .returning();

    const cleaned = await expiryService.cleanupExpiredHolds(new Date());
    expect(cleaned).toBeGreaterThanOrEqual(1);

    const [cancelledAppt] = await db.select().from(appointment).where(eq(appointment.id, expiredAppt.id));
    expect(cancelledAppt.status).toBe('cancelled');

    const [failedPay] = await db.select().from(payment).where(eq(payment.id, expiredPay.id));
    expect(failedPay.status).toBe('failed');
    expect(failedPay.failureReason).toContain('Hold expired');

    // Slot is now free for re-booking
    const rebooked = await request(app.getHttpServer())
      .post('/api/appointments')
      .set('x-test-user-id', unauthorizedPatientUser.id)
      .send({
        doctorProfileId: activeDoctorProfileId,
        startsAt: '2027-11-15T06:00:00.000Z',
        endsAt: '2027-11-15T06:30:00.000Z',
      })
      .expect(201);

    expect(rebooked.body.status).toBe('pending_payment');

    await db.delete(payment).where(eq(payment.appointmentId, rebooked.body.id));
    await db.delete(appointment).where(eq(appointment.id, rebooked.body.id));
    await db.delete(payment).where(eq(payment.id, expiredPay.id));
    await db.delete(appointment).where(eq(appointment.id, expiredAppt.id));
  });

  it('12. Rejects unauthorized access to admin payment and refund endpoints', async () => {
    // Patient attempts to access admin payments list
    await request(app.getHttpServer())
      .get('/api/admin/payments')
      .set('x-test-user-id', patientUser.id)
      .set('x-test-user-role', 'patient')
      .expect(403);

    // Patient attempts to trigger refund
    await request(app.getHttpServer())
      .post(`/api/admin/payments/${createdPaymentRecordId}/refund`)
      .set('x-test-user-id', patientUser.id)
      .set('x-test-user-role', 'patient')
      .send({ reason: 'Unauthorized attempt' })
      .expect(403);
  });

  it('13. Admin issues full refund -> creates refund record and updates payment status', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/admin/payments/${createdPaymentRecordId}/refund`)
      .set('x-test-user-id', adminUser.id)
      .set('x-test-user-role', 'admin')
      .send({
        reason: 'Patient requested cancellation',
        notes: 'Approved by admin',
      })
      .expect(200);

    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('processed');
    expect(res.body.razorpayRefundId).toBe('rfnd_e2e_mock_123');
    expect(res.body.amountPaise).toBe(50000);

    // Verify database state
    const [updatedPay] = await db
      .select()
      .from(payment)
      .where(eq(payment.id, createdPaymentRecordId));
    expect(updatedPay.status).toBe('refunded');
    expect(updatedPay.refundedAmountPaise).toBe(50000);

    const [dbRefund] = await db
      .select()
      .from(refund)
      .where(eq(refund.id, res.body.id));
    expect(dbRefund).toBeDefined();
    expect(dbRefund.status).toBe('processed');
    expect(dbRefund.arn).toBe('ARN_E2E_789456');
  });

  it('14. Over-refund and duplicate refund prevention: rejects when balance is 0', async () => {
    await request(app.getHttpServer())
      .post(`/api/admin/payments/${createdPaymentRecordId}/refund`)
      .set('x-test-user-id', adminUser.id)
      .set('x-test-user-role', 'admin')
      .send({
        reason: 'Duplicate refund attempt',
      })
      .expect(400);
  });

  it('15. Admin inspection APIs return comprehensive payment, appointment, and refund history', async () => {
    // 1. List payments
    const listRes = await request(app.getHttpServer())
      .get('/api/admin/payments')
      .set('x-test-user-id', adminUser.id)
      .set('x-test-user-role', 'admin')
      .expect(200);

    expect(listRes.body.payments).toBeDefined();
    expect(listRes.body.payments.length).toBeGreaterThanOrEqual(1);
    expect(listRes.body.totalCount).toBeGreaterThanOrEqual(1);

    // 2. Get payment details with refunds
    const detailRes = await request(app.getHttpServer())
      .get(`/api/admin/payments/${createdPaymentRecordId}`)
      .set('x-test-user-id', adminUser.id)
      .set('x-test-user-role', 'admin')
      .expect(200);

    expect(detailRes.body.id).toBe(createdPaymentRecordId);
    expect(detailRes.body.refunds).toHaveLength(1);
    expect(detailRes.body.refunds[0].amountPaise).toBe(50000);
    expect(detailRes.body.appointment).toBeDefined();

    // 3. List refunds
    const refundsRes = await request(app.getHttpServer())
      .get('/api/admin/refunds')
      .set('x-test-user-id', adminUser.id)
      .set('x-test-user-role', 'admin')
      .expect(200);

    expect(refundsRes.body.refunds).toBeDefined();
    expect(refundsRes.body.refunds.length).toBeGreaterThanOrEqual(1);
  });

  it('16. Webhook refund.processed event handles external refunds idempotently', async () => {
    const refundWebhookPayload = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_e2e_mock_123',
            payment_id: activePaymentId,
            amount: 50000,
            status: 'processed',
            acquirer_data: { arn: 'ARN_E2E_789456' },
          },
        },
      },
    };
    const rawBody = JSON.stringify(refundWebhookPayload);
    const signature = createHmac('sha256', testWebhookSecret).update(rawBody).digest('hex');

    const res = await request(app.getHttpServer())
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', signature)
      .set('Content-Type', 'application/json')
      .send(refundWebhookPayload)
      .expect(200);

    expect(res.body.received).toBe(true);
  });

  it('17. Automated background reconciliation sweeps inconsistent payment states', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/admin/reconcile')
      .set('x-test-user-id', adminUser.id)
      .set('x-test-user-role', 'admin')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.reconciledCount).toBeDefined();
  });

  it('18. Paid appointment cancellation triggers immediate refund and transitions payment to refunded', async () => {
    // 1. Create a scheduled appointment with a captured payment
    const [scheduledAppt] = await db
      .insert(appointment)
      .values({
        id: randomUUID(),
        patientId: patientUser.id,
        doctorId: doctorUser.id,
        startsAt: new Date('2027-11-20T08:00:00.000Z'),
        endsAt: new Date('2027-11-20T08:30:00.000Z'),
        status: 'scheduled',
      })
      .returning();

    const [capturedPay] = await db
      .insert(payment)
      .values({
        id: randomUUID(),
        appointmentId: scheduledAppt.id,
        patientId: patientUser.id,
        doctorId: doctorUser.id,
        razorpayOrderId: `order_cancel_refund_${Date.now()}`,
        razorpayPaymentId: `pay_cancel_refund_${Date.now()}`,
        amountPaise: 50000,
        currency: 'INR',
        status: 'captured',
        receipt: 'rcpt_cancel_refund',
        refundedAmountPaise: 0,
      })
      .returning();

    // 2. Patient cancels the paid appointment
    const res = await request(app.getHttpServer())
      .patch(`/api/appointments/${scheduledAppt.id}/cancel`)
      .set('x-test-user-id', patientUser.id)
      .set('x-test-user-role', 'patient')
      .expect(200);

    expect(res.body.status).toBe('cancelled');
    expect(res.body.refund).toBeDefined();
    expect(res.body.refund.status).toBe('processed');

    // 3. Verify database state
    const [dbAppt] = await db.select().from(appointment).where(eq(appointment.id, scheduledAppt.id));
    expect(dbAppt.status).toBe('cancelled');

    const [dbPay] = await db.select().from(payment).where(eq(payment.id, capturedPay.id));
    expect(dbPay.status).toBe('refunded');
    expect(dbPay.refundedAmountPaise).toBe(50000);

    const [dbRefund] = await db.select().from(refund).where(eq(refund.paymentId, capturedPay.id));
    expect(dbRefund).toBeDefined();
    expect(dbRefund.status).toBe('processed');
    expect(dbRefund.amountPaise).toBe(50000);

    // Clean up
    await db.delete(refund).where(eq(refund.id, dbRefund.id));
    await db.delete(payment).where(eq(payment.id, capturedPay.id));
    await db.delete(appointment).where(eq(appointment.id, scheduledAppt.id));
  }, 15000);
});
