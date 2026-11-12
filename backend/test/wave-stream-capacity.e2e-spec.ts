import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { and, count, eq, like } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { AuthSessionGuard } from '../src/auth/auth-session.guard.js';
import { REQUIRED_ROLES } from '../src/auth/roles.decorator.js';
import { RolesGuard } from '../src/auth/roles.guard.js';
import { db, pool } from '../src/db/database.js';
import {
  appointment,
  doctorAvailability,
  doctorLeave,
  doctorProfile,
  doctorScheduleOverride,
  user,
} from '../src/db/schema.js';
import { RAZORPAY_TOKEN } from '../src/payments/razorpay.provider.js';

describe('Wave/Stream PostgreSQL capacity integration', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const tag = `wave-stream-${randomUUID()}`;
  const doctorId = randomUUID();
  const doctorProfileId = randomUUID();
  const patientIds = Array.from({ length: 12 }, () => randomUUID());
  let app: INestApplication | undefined;

  const weeklySchedule = {
    timezone: 'UTC',
    activeDays: [1, 2, 3, 4, 5],
    startHour: 9,
    endHour: 17,
    slotDurationMinutes: 30,
    schedulingMode: 'stream' as const,
    capacity: 1,
    breakStart: null,
    breakEnd: null,
  };

  async function removeTaggedFixtures(): Promise<void> {
    await db.delete(appointment).where(eq(appointment.doctorId, doctorId));
    await db.delete(doctorScheduleOverride).where(eq(doctorScheduleOverride.doctorId, doctorId));
    await db.delete(doctorLeave).where(eq(doctorLeave.doctorId, doctorId));
    await db.delete(doctorAvailability).where(eq(doctorAvailability.doctorId, doctorId));
    await db.delete(doctorProfile).where(eq(doctorProfile.id, doctorProfileId));
    await db.delete(user).where(like(user.email, `${tag}-%@e2e.invalid`));
  }

  async function countTaggedFixtures(): Promise<number> {
    const [users, profiles, schedules, leaves, overrides, appointments] = await Promise.all([
      db.select({ id: user.id }).from(user).where(like(user.email, `${tag}-%@e2e.invalid`)),
      db.select({ id: doctorProfile.id }).from(doctorProfile).where(eq(doctorProfile.id, doctorProfileId)),
      db.select({ id: doctorAvailability.id }).from(doctorAvailability).where(eq(doctorAvailability.doctorId, doctorId)),
      db.select({ id: doctorLeave.id }).from(doctorLeave).where(eq(doctorLeave.doctorId, doctorId)),
      db.select({ id: doctorScheduleOverride.id }).from(doctorScheduleOverride).where(eq(doctorScheduleOverride.doctorId, doctorId)),
      db.select({ id: appointment.id }).from(appointment).where(eq(appointment.doctorId, doctorId)),
    ]);
    return users.length + profiles.length + schedules.length + leaves.length + overrides.length + appointments.length;
  }

  function asUser(id: string) {
    const agent = request(app!.getHttpServer());
    return {
      get: (path: string) => agent.get(path).set('x-test-user-id', id),
      post: (path: string) => agent.post(path).set('x-test-user-id', id),
      put: (path: string) => agent.put(path).set('x-test-user-id', id),
    };
  }

  async function book(patientId: string, startsAt: string) {
    const start = new Date(startsAt);
    return asUser(patientId).post('/api/appointments').send({
      doctorProfileId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    });
  }

  async function readSlots(date: string) {
    return asUser(patientIds[0]!).get('/api/appointments/availability').query({ doctorProfileId, date });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    try {
      const fixtureUsers = [
        { id: doctorId, role: 'doctor' as const, name: 'Synthetic Wave Stream Doctor', email: `${tag}-doctor@e2e.invalid` },
        ...patientIds.map((id, index) => ({
          id,
          role: 'patient' as const,
          name: `Synthetic Wave Stream Patient ${index + 1}`,
          email: `${tag}-patient-${index + 1}@e2e.invalid`,
        })),
      ];
      await db.insert(user).values(fixtureUsers.map(({ id, name, email, role }) => ({
        id,
        name,
        email,
        role,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })));
      await db.insert(doctorProfile).values({
        id: doctorProfileId,
        userId: doctorId,
        specialty: 'Synthetic Scheduling Test',
        licenseRegion: 'SYNTHETIC',
        licenseNumber: tag,
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: doctorId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const reflector = new Reflector();
      const fixtureRoles = new Map(fixtureUsers.map(({ id, role }) => [id, role]));
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(RAZORPAY_TOKEN)
        .useValue({
          orders: { create: vi.fn() },
          payments: { fetch: vi.fn(), refund: vi.fn() },
          refunds: { fetch: vi.fn() },
        })
        .overrideGuard(AuthSessionGuard)
        .useValue({
          canActivate: (context: any) => {
            const req = context.switchToHttp().getRequest();
            const id = req.headers['x-test-user-id'];
            const role = fixtureRoles.get(id);
            if (!id || !role) return false;
            const fixture = fixtureUsers.find((candidate) => candidate.id === id)!;
            const current = { id, role, email: fixture.email, name: fixture.name };
            req.authUser = current;
            req.user = current;
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
            if (!requiredRoles?.length) return true;
            const req = context.switchToHttp().getRequest();
            const current = req.authUser ?? req.user;
            return Boolean(current && requiredRoles.includes(current.role));
          },
        })
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();

      const scheduleResponse = await asUser(doctorId)
        .put('/api/doctor/schedule')
        .send(weeklySchedule);
      if (scheduleResponse.status !== 200) {
        throw new Error(`Synthetic weekly schedule setup failed with HTTP ${scheduleResponse.status}.`);
      }
    } catch (error) {
      await app?.close();
      await removeTaggedFixtures();
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
      await removeTaggedFixtures();
      const remaining = await countTaggedFixtures();
      if (remaining !== 0) throw new Error(`Synthetic Wave/Stream fixture cleanup left ${remaining} tagged records.`);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      await pool.end();
    }
  }, 30_000);

  it('persists weekly Stream capacity 1 and rejects a second booking including against the pending hold', async () => {
    const persisted = await asUser(doctorId).get('/api/doctor/schedule');
    expect(persisted.status).toBe(200);
    expect(persisted.body).toMatchObject({ schedulingMode: 'stream', capacity: 1, activeDays: [1, 2, 3, 4, 5] });

    const slot = await readSlots('2027-01-04');
    expect(slot.status).toBe(200);
    expect(slot.body.slots[0]).toMatchObject({ mode: 'stream', capacity: 1, remainingCapacity: 1, sessionId: null });
    const startsAt = '2027-01-04T09:00:00.000Z';
    const first = await book(patientIds[0]!, startsAt);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('pending_payment');

    const remaining = await readSlots('2027-01-04');
    expect(remaining.body.slots.some((entry: { startsAt: string }) => entry.startsAt === startsAt)).toBe(false);
    const second = await book(patientIds[1]!, startsAt);
    expect(second.status).toBe(409);
  }, 30_000);

  it('persists weekly Wave capacity 3 and admits exactly three bookings at one time window', async () => {
    const response = await asUser(doctorId).put('/api/doctor/schedule').send({
      ...weeklySchedule,
      schedulingMode: 'wave',
      capacity: 3,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ schedulingMode: 'wave', capacity: 3 });

    const startsAt = '2027-01-05T10:00:00.000Z';
    const before = await readSlots('2027-01-05');
    expect(before.body.slots[2]).toMatchObject({ mode: 'wave', capacity: 3, remainingCapacity: 3 });
    for (const patientId of patientIds.slice(2, 5)) {
      const created = await book(patientId, startsAt);
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('pending_payment');
    }
    const atCapacity = await readSlots('2027-01-05');
    expect(atCapacity.body.slots.some((entry: { startsAt: string }) => entry.startsAt === startsAt)).toBe(false);
    const rejected = await book(patientIds[5]!, startsAt);
    expect(rejected.status).toBe(409);
  }, 30_000);

  it('serializes concurrent booking transactions and never exceeds Wave capacity 3', async () => {
    const startsAt = '2027-01-06T11:00:00.000Z';
    const results = await Promise.all(patientIds.slice(6, 12).map((patientId) => book(patientId, startsAt)));
    expect(results.filter((result) => result.status === 201)).toHaveLength(3);
    expect(results.filter((result) => result.status === 409)).toHaveLength(3);
    const [rows] = await db.select({ count: count() }).from(appointment)
      .where(and(eq(appointment.doctorId, doctorId), eq(appointment.startsAt, new Date(startsAt))));
    expect(Number(rows?.count)).toBe(3);
  }, 30_000);

  it('applies a persisted Sunday date override without changing weekly Wave capacity', async () => {
    const override = await asUser(doctorId).put('/api/doctor/schedule/override').send({
      date: '2027-01-03',
      startHour: 12,
      endHour: 13,
      slotDurationMinutes: 30,
      schedulingMode: 'wave',
      capacity: 2,
      breakStart: null,
      breakEnd: null,
    });
    expect(override.status).toBe(200);

    const overrideSlots = await readSlots('2027-01-03');
    expect(overrideSlots.status).toBe(200);
    expect(overrideSlots.body).toMatchObject({ mode: 'wave', capacity: 2, durationMinutes: 30 });
    expect(overrideSlots.body.slots[0]).toMatchObject({ mode: 'wave', capacity: 2, remainingCapacity: 2 });
    const startsAt = '2027-01-03T12:00:00.000Z';
    expect((await book(patientIds[0]!, startsAt)).status).toBe(201);
    expect((await book(patientIds[1]!, startsAt)).status).toBe(201);
    expect((await book(patientIds[2]!, startsAt)).status).toBe(409);

    const weeklySlots = await readSlots('2027-01-07');
    expect(weeklySlots.body).toMatchObject({ mode: 'wave', capacity: 3 });
  }, 30_000);
});
