import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import {
  loadAssistantTestEnvironment, validateTestTarget, verifyTestDatabase,
} from '../scripts/verify-assistant-test-db.mjs';
import { appointment, appointmentIdempotency, doctorProfile, payment, refund, user } from '../src/db/schema.js';

const selectTool = vi.fn();
const rejectRazorpay = vi.fn(async () => { throw new Error('Unexpected Razorpay call in assistant test.'); });
const emails: string[] = [];
const appointmentIds: string[] = [];
let app: INestApplication | undefined;
let database: typeof import('../src/db/database.js') | undefined;
let http: ReturnType<typeof request>;

const sqlErrors: Record<string, string> = {
  '22P02': 'Invalid database value or enum label',
  '23502': 'Required column received null',
  '23503': 'Referenced fixture row does not exist',
  '23505': 'Duplicate value violates a unique constraint',
  '23514': 'Value violates a check constraint',
  '23P01': 'Value violates an exclusion constraint',
  '42501': 'Database role has insufficient privileges',
  '42703': 'Required column is missing from the database schema',
  '42P01': 'Required table is missing from the database schema',
};

class FixtureSeedError extends Error {}

async function fixtureStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FixtureSeedError) throw error;
    const seen = new Set<unknown>();
    let current = error;
    while (current && typeof current === 'object' && !seen.has(current)) {
      seen.add(current);
      const entry = current as Record<string, unknown>;
      if (typeof entry.code === 'string' && /^[0-9A-Z]{5}$/.test(entry.code)) {
        const constraint = typeof entry.constraint === 'string' &&
          /^(?:user|doctor_profile|appointment|payment|refund)_[a-z0-9_]{1,62}$/.test(entry.constraint)
          ? `; constraint ${entry.constraint}` : '';
        const columnMatch = entry.code === '42703' && typeof entry.message === 'string'
          ? /^column "([a-z_]+)"(?: of relation "[a-z_]+")? does not exist$/.exec(entry.message) : null;
        const column = columnMatch ? `; column ${columnMatch[1]}` : '';
        throw new FixtureSeedError(`Assistant fixture step "${label}" failed [${entry.code}]: ${sqlErrors[entry.code] ?? 'PostgreSQL rejected the operation'}${constraint}${column}.`);
      }
      current = entry.cause;
    }
    const status = error instanceof Error ? /expected (\d{3}) .*got (\d{3})/.exec(error.message) : null;
    throw new FixtureSeedError(`Assistant fixture step "${label}" failed${status ? ` (expected HTTP ${status[1]}, received ${status[2]})` : ' without a PostgreSQL error code'}.`);
  }
}

function sessionCookie(headers: { [key: string]: unknown }) {
  const cookies = headers['set-cookie'];
  if (!Array.isArray(cookies) || !cookies.length) throw new Error('Better Auth did not set a session cookie.');
  return cookies.map((cookie: string) => cookie.split(';', 1)[0]).join('; ');
}

async function signup() {
  const credentials = {
    email: `assistant-http-${randomUUID()}@example.test`,
    name: 'Assistant HTTP Fixture',
    password: randomUUID(),
  };
  emails.push(credentials.email);
  const response = await http.post('/api/auth/sign-up/email').send(credentials).expect(200);
  const id: string = response.body.user.id;
  expect(typeof id).toBe('string');
  return { id, credentials, cookie: sessionCookie(response.headers) };
}

async function assertSession(cookie: string, fixture: { id: string; credentials: { email: string } }, role: string) {
  const { body } = await http.get('/api/auth/get-session').set('Cookie', cookie).expect(200);
  expect({ id: body?.user?.id, email: body?.user?.email, role: body?.user?.role })
    .toEqual({ id: fixture.id, email: fixture.credentials.email, role });
}

function chat(message: string, cookie?: string) {
  const operation = http.post('/api/assistant/chat').send({ message });
  if (cookie) operation.set('Cookie', cookie);
  return operation.timeout({ deadline: 15_000 });
}

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  const env = loadAssistantTestEnvironment();
  const target = validateTestTarget(env);
  await verifyTestDatabase(env);
  console.log(`Verified assistant HTTP test database ${target.database} at ${target.host}.`);

  for (const [key, value] of Object.entries({
    DATABASE_URL: target.connectionString,
    BETTER_AUTH_URL: 'http://127.0.0.1:5000',
    FRONTEND_URL: 'http://127.0.0.1:3000',
    BETTER_AUTH_SECRET: randomUUID(),
    EMAIL_DELIVERY_MODE: 'disabled',
    EMAIL_TEST_RECIPIENT: undefined,
    RESEND_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    GEMINI_MODEL: undefined,
    RAZORPAY_KEY_ID: 'rzp_test_assistant_http',
    RAZORPAY_KEY_SECRET: 'assistant-http-test-placeholder',
    RAZORPAY_WEBHOOK_SECRET: 'assistant-http-test-placeholder',
  })) vi.stubEnv(key, value);

  database = await import('../src/db/database.js');
  const [
    { registerAuthHandler }, { AssistantModule }, { ASSISTANT_PROVIDER },
    { AppointmentExpiryService }, { PaymentReconciliationService }, { RAZORPAY_TOKEN },
  ] = await Promise.all([
    import('../src/auth/auth-handler.js'),
    import('../src/assistant/assistant.module.js'),
    import('../src/assistant/assistant-provider.js'),
    import('../src/appointments/appointment-expiry.service.js'),
    import('../src/payments/payment-reconciliation.service.js'),
    import('../src/payments/razorpay.provider.js'),
  ]);
  // Prevent startup sweeps while retaining the real reconciliation service for read-path assertions.
  vi.spyOn(AppointmentExpiryService.prototype, 'onModuleInit').mockResolvedValue();
  vi.spyOn(PaymentReconciliationService.prototype, 'onModuleInit').mockResolvedValue();
  const module = await Test.createTestingModule({ imports: [AssistantModule] })
    .overrideProvider(ASSISTANT_PROVIDER).useValue({ selectTool })
    .overrideProvider(RAZORPAY_TOKEN).useValue({
      orders: { create: rejectRazorpay },
      payments: { fetch: rejectRazorpay, refund: rejectRazorpay },
      refunds: { fetch: rejectRazorpay },
    })
    .compile();
  app = module.createNestApplication({ bodyParser: false, logger: false });
  const server = app.getHttpAdapter().getInstance();
  registerAuthHandler(server);
  server.use(express.json());
  await app.listen(0, '127.0.0.1');
  http = request(app.getHttpServer());
  // Verify loopback and auth routing before inserting fixtures.
  await http.get('/api/auth/get-session').expect(200, null);
});

afterAll(async () => {
  const failures: string[] = [];
  try {
    await app?.close();
  } catch { failures.push('application close'); }
  try {
    if (database) {
      const { db } = database;
      if (appointmentIds.length) {
        await db.delete(appointmentIdempotency).where(inArray(appointmentIdempotency.appointmentId, appointmentIds));
        await db.delete(appointment).where(inArray(appointment.id, appointmentIds));
      }
      if (emails.length) {
        const users = db.select({ id: user.id }).from(user).where(inArray(user.email, emails));
        await db.delete(doctorProfile).where(inArray(doctorProfile.userId, users));
        await db.delete(user).where(inArray(user.email, emails));
      }
    }
  } catch { failures.push('fixture cleanup'); }
  try {
    await database?.pool.end();
  } catch { failures.push('database pool close'); }
  finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
  if (failures.length) throw new Error(`Assistant HTTP cleanup failed (${failures.join(', ')}).`);
});

beforeEach(() => {
  selectTool.mockReset();
  rejectRazorpay.mockClear();
});

it('signs up, signs in, verifies the session cookie, and signs out over HTTP', async () => {
  const patient = await signup();
  await assertSession(patient.cookie, patient, 'patient');
  await http.post('/api/auth/sign-out').set('Cookie', patient.cookie).expect(200);
  await http.get('/api/auth/get-session').set('Cookie', patient.cookie).expect(200, null);
  const login = await http.post('/api/auth/sign-in/email').send(patient.credentials).expect(200);
  const cookie = sessionCookie(login.headers);
  await assertSession(cookie, patient, 'patient');
  await http.post('/api/auth/sign-out').set('Cookie', cookie).expect(200);
  await http.get('/api/auth/get-session').set('Cookie', cookie).expect(200, null);
});

it('denies unauthenticated assistant requests before calling the provider', async () => {
  await chat('Show my appointments').expect(401);
  expect(selectTool).not.toHaveBeenCalled();
});

describe('assistant authorization and limits', () => {
  let patientA: Awaited<ReturnType<typeof signup>>;
  let patientB: typeof patientA;
  let doctor: typeof patientA & { profileId: string };
  let pendingDoctor: typeof patientA & { profileId: string };
  const ownId = randomUUID();
  const otherId = randomUUID();
  const completedId = randomUUID();
  const startsAt = '2031-05-15T04:15:00.000Z';
  const endsAt = '2031-05-15T04:16:00.000Z';

  async function doctorFixture(approved: boolean) {
    const label = approved ? 'approved doctor' : 'pending doctor';
    const fixture = await fixtureStep(`sign up ${label}`, signup);
    const profileId = randomUUID();
    const { db } = database!;
    await fixtureStep(`prepare ${label}`, () => db.transaction(async (tx) => {
      await fixtureStep(`set role for ${label}`, async () => {
        const [updated] = await tx.update(user).set({ role: 'doctor' })
          .where(eq(user.id, fixture.id)).returning({ id: user.id });
        if (!updated) throw new Error('Fixture user was not found.');
      });
      await fixtureStep(`insert profile for ${label}`, async () => {
        await tx.insert(doctorProfile).values({
          id: profileId, userId: fixture.id, specialty: 'Cardiology', licenseRegion: 'Test',
          licenseNumber: randomUUID(), status: approved ? 'approved' : 'pending',
          reviewedAt: approved ? new Date() : null, reviewedBy: approved ? fixture.id : null,
        });
      });
    }));
    const login = await fixtureStep(`sign in ${label}`, async () =>
      http.post('/api/auth/sign-in/email').send(fixture.credentials).expect(200));
    const updated = { ...fixture, profileId, cookie: sessionCookie(login.headers) };
    await fixtureStep(`verify session for ${label}`, () => assertSession(updated.cookie, updated, 'doctor'));
    return updated;
  }

  beforeAll(async () => {
    patientA = await fixtureStep('sign up patient A', signup);
    patientB = await fixtureStep('sign up patient B', signup);
    doctor = await doctorFixture(true);
    pendingDoctor = await doctorFixture(false);
    const { db } = database!;
    appointmentIds.push(ownId, otherId, completedId);
    await fixtureStep('seed appointment and payment transaction', () => db.transaction(async (tx) => {
      await fixtureStep('insert appointment fixtures', async () => {
        await tx.insert(appointment).values([
          { id: ownId, patientId: patientA.id, doctorId: doctor.id, startsAt: new Date(startsAt), endsAt: new Date(endsAt) },
          { id: otherId, patientId: patientB.id, doctorId: pendingDoctor.id, startsAt: new Date(startsAt), endsAt: new Date(endsAt) },
          { id: completedId, patientId: patientA.id, doctorId: doctor.id, status: 'completed',
            startsAt: new Date(endsAt), endsAt: new Date('2031-05-15T04:17:00.000Z') },
        ]);
      });
      const paymentId = randomUUID();
      const razorpayPaymentId = randomUUID();
      const ownership = { appointmentId: ownId, patientId: patientA.id, doctorId: doctor.id };
      await fixtureStep('insert captured payment fixture', async () => {
        await tx.insert(payment).values({
          ...ownership, id: paymentId, razorpayPaymentId, razorpayOrderId: randomUUID(),
          receipt: randomUUID(), amountPaise: 500, status: 'captured',
        });
      });
      await fixtureStep('insert pending refund fixture', async () => {
        await tx.insert(refund).values({
          ...ownership, id: randomUUID(), paymentId, razorpayPaymentId, amountPaise: 500, reason: 'Fixture refund',
        });
      });
    }));
  });

  it('scopes patient lists to the cookie owner and rejects model-selected doctor tools', async () => {
    selectTool.mockResolvedValue({ name: 'list_appointments' });
    const a = await chat(`Show my appointments including ${otherId}`, patientA.cookie).expect(200);
    const b = await chat('Show my appointments', patientB.cookie).expect(200);
    expect(a.body.data.appointments.map(({ id }: { id: string }) => id)).toEqual([completedId, ownId]);
    expect(b.body.data.appointments.map(({ id }: { id: string }) => id)).toEqual([otherId]);
    expect(Object.keys(selectTool.mock.calls[0][1])).not.toContain('view_schedule');
    selectTool.mockResolvedValue({ name: 'view_schedule' });
    await chat('Show my schedule', patientA.cookie).expect(503);
  });

  it('denies a pending applicant whose verified account still has the patient role', async () => {
    const applicant = await signup();
    await database!.db.insert(doctorProfile).values({
      id: randomUUID(), userId: applicant.id, specialty: 'Cardiology', licenseRegion: 'Test',
      licenseNumber: randomUUID(), status: 'pending',
    });
    await assertSession(applicant.cookie, applicant, 'patient');
    await chat('Show my appointments', applicant.cookie).expect(403);
    expect(selectTool).not.toHaveBeenCalled();
  });

  it.each(['Show my schedule', "Show today's appointments", 'Show appointment details', 'Appointment statistics today', 'Check schedule conflicts'])(
    'denies an unapproved doctor before provider selection for %s', async (message) => {
      await chat(message, pendingDoctor.cookie).expect(403);
      expect(selectTool).not.toHaveBeenCalled();
    },
  );

  it('permits approved doctor reads, scopes details by assignment, and exposes no patient fields', async () => {
    await http.put('/api/doctor/schedule').set('Cookie', doctor.cookie)
      .send({ timezone: 'America/New_York', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }).expect(200);
    selectTool.mockResolvedValue({ name: 'view_schedule' });
    const schedule = await chat('Show my schedule', doctor.cookie).expect(200);
    expect(schedule.body.tool).toBe('view_schedule');
    selectTool.mockResolvedValue({ name: 'appointment_details' });
    const own = await chat(`Show appointment details ${ownId}`, doctor.cookie).expect(200);
    expect(own.body.data.id).toBe(ownId);
    expect(own.body.data.timezone).toBe('America/New_York');
    expect(Object.keys(own.body.data).sort()).toEqual(['endsAt', 'id', 'startsAt', 'status', 'timezone']);
    const foreign = await chat(`Show appointment details ${otherId}`, doctor.cookie).expect(404);
    const missing = await chat(`Show appointment details ${randomUUID()}`, doctor.cookie).expect(404);
    expect(foreign.body).toEqual(missing.body);
  });

  it('leaves appointment, payment, and refund rows unchanged after assistant reads', async () => {
    const { db } = database!;
    const snapshot = () => Promise.all([
      db.select().from(appointment).where(inArray(appointment.id, appointmentIds)).orderBy(appointment.id),
      db.select().from(payment).where(eq(payment.appointmentId, ownId)),
      db.select().from(refund).where(eq(refund.appointmentId, ownId)),
    ]);
    const before = await snapshot();
    expect(before.map((rows) => rows.length)).toEqual([3, 1, 1]);
    selectTool.mockResolvedValueOnce({ name: 'list_appointments' }).mockResolvedValueOnce({ name: 'appointment_details' });
    await chat('Show my appointments', patientA.cookie).expect(200);
    await chat(`Show appointment details ${ownId}`, doctor.cookie).expect(200);
    expect(await snapshot()).toEqual(before);
    expect(rejectRazorpay).not.toHaveBeenCalled();
  });

  it.each(['appointment_statistics', 'schedule_conflicts'])('rejects a model-selected %s for a patient', async (name) => {
    selectTool.mockResolvedValue({ name });
    await chat('Appointment statistics and schedule conflicts', patientA.cookie).expect(503);
    expect(Object.keys(selectTool.mock.lastCall![1])).not.toContain(name);
  });

  it('counts all statuses for the session doctor on the specified local day', async () => {
    await http.put('/api/doctor/schedule').set('Cookie', doctor.cookie)
      .send({ timezone: 'America/New_York', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }).expect(200);
    selectTool.mockResolvedValue({ name: 'appointment_statistics' });
    const response = await chat('Appointment statistics for 2031-05-15', doctor.cookie).expect(200);
    expect(response.body.data).toEqual({
      date: '2031-05-15', timezone: 'America/New_York', total: 2,
      byStatus: { pending_payment: 0, scheduled: 1, completed: 1, cancelled: 0 },
    });
  });

  it('returns only the session doctor’s scheduled overlaps with no patient fields', async () => {
    selectTool.mockResolvedValue({ name: 'schedule_conflicts' });
    const response = await chat(`Check conflicts from 2031-05-15T04:14:00Z to 2031-05-15T04:18:00Z for ${otherId}`, doctor.cookie).expect(200);
    expect(response.body.data.conflicts).toEqual([{ id: ownId, startsAt, endsAt }]);
    const adjacent = await chat(`Check conflicts from ${endsAt} to 2031-05-15T04:18:00Z`, doctor.cookie).expect(200);
    expect(adjacent.body.data.conflicts).toEqual([]);
  });

  it('clarifies invalid doctor date and range requests over HTTP', async () => {
    selectTool.mockResolvedValueOnce({ name: 'appointment_statistics' }).mockResolvedValueOnce({ name: 'schedule_conflicts' });
    const badDate = await chat('Appointment statistics for 2031-02-30', doctor.cookie).expect(200);
    const badRange = await chat('Check conflicts from 2031-05-15T11:00Z to 2031-05-15T10:00Z', doctor.cookie).expect(200);
    expect(badDate.body).toMatchObject({ tool: 'clarify', data: null });
    expect(badRange.body).toMatchObject({ tool: 'clarify', data: null });
  });

  it('limits each session user to ten provider calls per rolling minute', async () => {
    const limited = await signup();
    const time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(time);
    try {
      selectTool.mockResolvedValue({ name: 'clarify' });
      for (let i = 0; i < 10; i++) await chat('Show my appointments', limited.cookie).expect(200);
      clock.mockReturnValue(time + 59_999);
      await chat('Show my appointments', limited.cookie).expect(429);
      expect(selectTool).toHaveBeenCalledTimes(10);
      await chat('Show my appointments', patientB.cookie).expect(200);
      clock.mockReturnValue(time + 60_000);
      await chat('Show my appointments', limited.cookie).expect(200);
      expect(selectTool).toHaveBeenCalledTimes(12);
    } finally { clock.mockRestore(); }
  });

  it('blocks overlapping calls for one user and releases the slot after a provider failure', async () => {
    const patient = await signup();
    const entered = deferredSignal();
    const release = deferredSignal();
    selectTool.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new ServiceUnavailableException();
    }).mockResolvedValue({ name: 'clarify' });
    const first = chat('Show my appointments', patient.cookie).expect(503).then(() => {});
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('Provider was not reached.'); })]);
      await chat('Show my appointments', patient.cookie).expect(429);
      expect(selectTool).toHaveBeenCalledTimes(1);
      await chat('Show my appointments', patientB.cookie).expect(200);
    } finally {
      release.resolve();
      await first;
    }
    await chat('Show my appointments', patient.cookie).expect(200);
    expect(selectTool).toHaveBeenCalledTimes(3);
  });

  it('serializes concurrent hold attempts for the same doctor slot across different patients with doctor-slot advisory lock', async () => {
    const slotBody = {
      doctorProfileId: doctor.profileId,
      startsAt: '2032-06-07T14:00:00.000Z',
      endsAt: '2032-06-07T14:30:00.000Z',
    };
    const keyA = randomUUID();
    const keyB = randomUUID();

    const [resA, resB] = await Promise.all([
      http.post('/api/appointments')
        .set('Cookie', patientA.cookie)
        .set('Idempotency-Key', keyA)
        .send(slotBody),
      http.post('/api/appointments')
        .set('Cookie', patientB.cookie)
        .set('Idempotency-Key', keyB)
        .send(slotBody),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winningRes = resA.status === 201 ? resA : resB;
    const losingRes = resA.status === 409 ? resA : resB;

    expect(winningRes.body.status).toBe('pending_payment');
    expect(typeof winningRes.body.id).toBe('string');
    appointmentIds.push(winningRes.body.id);

    expect(losingRes.body.message).toContain('already has a scheduled appointment in that time slot');

    const winningCookie = resA.status === 201 ? patientA.cookie : patientB.cookie;
    const winningKey = resA.status === 201 ? keyA : keyB;

    const retry = await http.post('/api/appointments')
      .set('Cookie', winningCookie)
      .set('Idempotency-Key', winningKey)
      .send(slotBody)
      .expect(201);
    expect(retry.body.id).toBe(winningRes.body.id);

    await http.post('/api/appointments')
      .set('Cookie', winningCookie)
      .set('Idempotency-Key', winningKey)
      .send({ ...slotBody, endsAt: '2032-06-07T14:35:00.000Z' })
      .expect(409);
  });

  it('safely handles PostgreSQL 55P03 advisory lock timeout without partial writes and permits retry', async () => {
    const { pool } = database!;
    const slotBody = {
      doctorProfileId: doctor.profileId,
      startsAt: '2032-06-07T15:00:00.000Z',
      endsAt: '2032-06-07T15:30:00.000Z',
    };
    const key = randomUUID();
    const blockingClient = await pool.connect();

    try {
      await blockingClient.query('BEGIN');
      const slotKey = JSON.stringify([doctor.profileId, slotBody.startsAt]);
      await blockingClient.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 1))',
        [slotKey],
      );

      const timedOutRes = await http.post('/api/appointments')
        .set('Cookie', patientA.cookie)
        .set('Idempotency-Key', key)
        .send(slotBody);

      expect(timedOutRes.status).toBe(503);
      expect(timedOutRes.body.message).toContain('busy');

      const { db } = database!;
      const partialAppts = await db.select().from(appointment).where(
        and(eq(appointment.doctorId, doctor.id), eq(appointment.startsAt, new Date(slotBody.startsAt)))
      );
      expect(partialAppts).toHaveLength(0);

      const partialIdempotency = await db.select().from(appointmentIdempotency).where(
        and(eq(appointmentIdempotency.patientId, patientA.id), eq(appointmentIdempotency.key, key))
      );
      expect(partialIdempotency).toHaveLength(0);
    } finally {
      await blockingClient.query('ROLLBACK');
      blockingClient.release();
    }

    const successRes = await http.post('/api/appointments')
      .set('Cookie', patientA.cookie)
      .set('Idempotency-Key', key)
      .send(slotBody)
      .expect(201);

    expect(successRes.body.status).toBe('pending_payment');
    appointmentIds.push(successRes.body.id);
  }, 25_000);

  it('serializes identical concurrent requests for the same patient and idempotency key returning the same appointment', async () => {
    const slotBody = {
      doctorProfileId: doctor.profileId,
      startsAt: '2032-06-07T15:30:00.000Z',
      endsAt: '2032-06-07T16:00:00.000Z',
    };
    const key = randomUUID();

    const [res1, res2] = await Promise.all([
      http.post('/api/appointments')
        .set('Cookie', patientA.cookie)
        .set('Idempotency-Key', key)
        .send(slotBody),
      http.post('/api/appointments')
        .set('Cookie', patientA.cookie)
        .set('Idempotency-Key', key)
        .send(slotBody),
    ]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    expect(res1.body.id).toBeDefined();
    expect(res1.body.id).toBe(res2.body.id);
    expect(res1.body.status).toBe('pending_payment');
    expect(res2.body.status).toBe('pending_payment');
    expect(res1.body.startsAt).toBe(res2.body.startsAt);
    expect(res1.body.endsAt).toBe(res2.body.endsAt);

    appointmentIds.push(res1.body.id);

    const { db } = database!;
    const apptRows = await db.select().from(appointment).where(
      and(
        eq(appointment.doctorId, doctor.id),
        eq(appointment.startsAt, new Date(slotBody.startsAt)),
      ),
    );
    expect(apptRows).toHaveLength(1);
    expect(apptRows[0].id).toBe(res1.body.id);
    expect(apptRows[0].patientId).toBe(patientA.id);

    const idempotencyRows = await db.select().from(appointmentIdempotency).where(
      and(
        eq(appointmentIdempotency.patientId, patientA.id),
        eq(appointmentIdempotency.key, key),
      ),
    );
    expect(idempotencyRows).toHaveLength(1);
    expect(idempotencyRows[0].appointmentId).toBe(res1.body.id);

    const replayRes = await http.post('/api/appointments')
      .set('Cookie', patientA.cookie)
      .set('Idempotency-Key', key)
      .send(slotBody)
      .expect(201);
    expect(replayRes.body.id).toBe(res1.body.id);

    await http.post('/api/appointments')
      .set('Cookie', patientA.cookie)
      .set('Idempotency-Key', key)
      .send({ ...slotBody, endsAt: '2032-06-07T16:05:00.000Z' })
      .expect(409);
  });
});
