import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppointmentQueueController } from './appointment-queue.controller.js';
import { AppointmentQueueService } from './appointment-queue.service.js';
import { AuthSessionVerifier } from '../auth/auth-session-verifier.js';
import { StaffAccessService } from '../auth/staff-access.service.js';
import * as store from './appointment-queue-store.js';

// Exercise real HTTP guards, validation and service orchestration together.
// Persistence/session boundaries are fixtures: these are not PostgreSQL concurrency tests.
vi.mock('../auth/auth.js', () => ({ auth: {} }));
vi.mock('../db/database.js', () => ({ db: {} }));
vi.mock('./appointment-queue-store.js', () => ({
  queueTransaction: vi.fn(), queueAppointment: vi.fn(), attendanceForAppointment: vi.fn(),
  queueTimezone: vi.fn(), bookingTokenForAppointment: vi.fn(), lockDailyQueue: vi.fn(), bumpQueueVersion: vi.fn(), allocateQueueToken: vi.fn(), insertCheckIn: vi.fn(), ownAttendanceRows: vi.fn(),
  dailyQueue: vi.fn(), readQueuePage: vi.fn(),
}));
const id = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-11-16T04:00:00Z');
const booking = { id, patientId: 'patient', doctorId: 'doctor', status: 'scheduled' as const,
  startsAt: new Date('2026-11-16T04:30:00Z'), endsAt: new Date('2026-11-16T04:45:00Z') };
const queue = { id: 'queue', serviceDate: '2026-11-16', timezone: 'Asia/Kolkata', version: 1 };

describe('queue release integration: HTTP → authorization → queue service', () => {
  let app: INestApplication;
  let attendance: store.QueueAttendance | undefined;
  let assigned: boolean;
  const verify = vi.fn();
  const assertAssigned = vi.fn();
  const query = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), for: vi.fn().mockReturnThis(), limit: vi.fn() };
  const tx = { select: vi.fn(() => query) };
  const session = (role: string, userId = role) => verify.mockResolvedValue({ user: { id: userId, role, name: 'Fixture', email: 'fixture@example.test' } });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AppointmentQueueController], providers: [
      AppointmentQueueService,
      { provide: StaffAccessService, useValue: { assertAssigned } },
      { provide: AuthSessionVerifier, useValue: { getSession: verify } },
    ] }).compile();
    app = module.createNestApplication({ logger: false }); await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    attendance = undefined; assigned = true; session('staff');
    query.limit.mockResolvedValue([{ id: 'approved' }]);
    assertAssigned.mockImplementation(async () => { if (!assigned) throw new ForbiddenException(); });
    vi.mocked(store.queueTransaction).mockImplementation(async callback => callback(tx as never));
    vi.mocked(store.queueAppointment).mockImplementation(async (_tx, appointmentId) => appointmentId === id ? booking : undefined);
    vi.mocked(store.attendanceForAppointment).mockImplementation(async () => attendance);
    vi.mocked(store.queueTimezone).mockResolvedValue('Asia/Kolkata');
    vi.mocked(store.bookingTokenForAppointment).mockResolvedValue({ appointmentId: id, doctorId: 'doctor', queueId: 'queue', appointmentStartsAt: booking.startsAt, tokenNumber: 1, timezone: 'Asia/Kolkata', serviceDate: '2026-11-16' } as never);
    vi.mocked(store.lockDailyQueue).mockResolvedValue({ id: 'queue' } as never);
    vi.mocked(store.bumpQueueVersion).mockResolvedValue(8);
    vi.mocked(store.allocateQueueToken).mockResolvedValue({ queue, tokenNumber: 1, queueVersion: 1 } as never);
    vi.mocked(store.insertCheckIn).mockImplementation(async (_tx, value) => { attendance = { ...value, version: 1, startedAt: null } as store.QueueAttendance; });
    vi.mocked(store.ownAttendanceRows).mockImplementation(async (_tx, patientId) => patientId !== 'patient' ? [] : [{
      appointmentId: id, bookingStatus: booking.status, attendance: attendance ?? null,
      position: attendance?.status === 'waiting' ? 1 : null, queue: attendance ? queue : null,
    }] as never);
    vi.mocked(store.dailyQueue).mockResolvedValue(queue as never);
    vi.mocked(store.readQueuePage).mockImplementation(async () => ({
      current: null, waitingCount: attendance ? 1 : 0,
      waiting: attendance ? [{ appointmentId: id, patientName: 'Patient Fixture', startsAt: booking.startsAt,
        endsAt: booking.endsAt, tokenNumber: 1, checkedInAt: now, position: 1, status: 'waiting' }] : [],
      expected: [], closed: [],
    }) as never);
  });
  afterEach(() => vi.useRealTimers());

  it('checks in once, returns the same token on retry, and exposes it to the owning patient and doctor', async () => {
    const first = await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send({}).expect(200);
    const retry = await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send({}).expect(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ status: 'waiting', tokenNumber: 1, position: 1, checkedInAt: now.toISOString(), timezone: 'Asia/Kolkata' });
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
    expect(store.insertCheckIn).toHaveBeenCalledTimes(1);
    session('patient');
    const own = await request(app.getHttpServer()).get(`/api/queues/mine?appointmentIds=${id}`).expect('Cache-Control', 'no-store').expect(200);
    expect(own.body.appointments).toEqual([first.body]);
    session('doctor');
    const daily = await request(app.getHttpServer()).get('/api/queues?doctorId=doctor&date=2026-11-16').expect(200);
    expect(daily.body.waiting[0]).toMatchObject({ patientName: 'Patient Fixture', tokenNumber: 1, position: 1,
      startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString() });
    expect(daily.body).toMatchObject({ waitingCount: 1, version: 1, nextCursor: null });
  });

  it('rechecks staff assignment even for a duplicate check-in after access is revoked', async () => {
    await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send({}).expect(200);
    assigned = false;
    await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send({}).expect(403);
    await request(app.getHttpServer()).get('/api/queues?doctorId=doctor&date=2026-11-16').expect(403);
    expect(store.insertCheckIn).toHaveBeenCalledTimes(1);
    expect(store.readQueuePage).not.toHaveBeenCalled();
  });

  it('prevents cross-patient and cross-doctor reads through the real service', async () => {
    session('patient', 'other-patient');
    await request(app.getHttpServer()).get(`/api/queues/mine?appointmentIds=${id}`).expect(404);
    session('doctor', 'other-doctor');
    await request(app.getHttpServer()).get('/api/queues?doctorId=doctor&date=2026-11-16').expect(404);
    expect(store.readQueuePage).not.toHaveBeenCalled();
  });

  it('rejects stale queue pagination and client token injection without writing', async () => {
    await request(app.getHttpServer()).get('/api/queues?doctorId=doctor&date=2026-11-16&cursor=0%3A10').expect(409);
    await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send({ tokenNumber: 99 }).expect(400);
    expect(store.readQueuePage).not.toHaveBeenCalled();
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
    expect(store.insertCheckIn).not.toHaveBeenCalled();
  });
});
