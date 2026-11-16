import { ConflictException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db/database.js';
import { loadEnv } from '../config/env.js';
import { AppointmentsService } from './appointments.service.js';
import { AppointmentsModule } from './appointments.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AppointmentQueueLifecycleModule } from './appointment-queue-lifecycle.module.js';
import { AppointmentQueueLifecycleService } from './appointment-queue-lifecycle.service.js';
import * as store from './appointment-queue-store.js';

vi.mock('../auth/auth.js', () => ({ auth: {} }));
vi.mock('../db/database.js', () => ({ db: { transaction: vi.fn() } }));
vi.mock('./appointment-queue-store.js', async importOriginal => ({
  ...await importOriginal<typeof store>(), attendanceForAppointment: vi.fn(), bumpQueueVersion: vi.fn(), lockDailyQueue: vi.fn(), queueTimezone: vi.fn(), queuesForBooking: vi.fn(),
}));
const now = new Date('2026-11-16T05:00:00Z');
const booking = { id: 'appointment', patientId: 'patient', doctorId: 'doctor', status: 'scheduled' as const,
  startsAt: new Date('2026-11-16T04:00:00Z'), endsAt: new Date('2026-11-16T04:30:00Z') };
const attendance = { appointmentId: booking.id, doctorId: 'doctor', queueId: 'queue', appointmentStartsAt: booking.startsAt,
  status: 'in_service', checkedInAt: new Date('2026-11-16T03:55:00Z'), startedAt: booking.startsAt, tokenNumber: 3, version: 2 };

describe('transactional queue lifecycle', () => {
  const reminders = { cancelForAppointment: vi.fn() };
  const lifecycle = new AppointmentQueueLifecycleService(reminders as never);
  const query = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), for: vi.fn().mockReturnThis(), limit: vi.fn() };
  const update = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), returning: vi.fn() };
  const tx = { select: vi.fn(() => query), update: vi.fn(() => update), insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue([]) })) };
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
    vi.mocked(store.attendanceForAppointment).mockResolvedValue(undefined);
    vi.mocked(store.queueTimezone).mockResolvedValue('UTC');
    vi.mocked(store.queuesForBooking).mockResolvedValue([]);
    vi.mocked(store.lockDailyQueue).mockResolvedValue({ id: 'queue', version: 7 } as never);
    vi.mocked(store.bumpQueueVersion).mockResolvedValue(8);
    query.limit.mockResolvedValue([{ id: 'queue', version: 7 }]);
    update.returning.mockResolvedValue([{ id: booking.id }]);
    reminders.cancelForAppointment.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('registers the shared lifecycle provider in both production write modules', () => {
    for (const module of [AppointmentsModule, PaymentsModule]) {
      expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, module)).toContain(AppointmentQueueLifecycleModule);
    }
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppointmentQueueLifecycleModule)).toContain(AppointmentQueueLifecycleService);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AppointmentQueueLifecycleModule)).toContain(AppointmentQueueLifecycleService);
  });

  it('locks the doctor before payment capture locks and refuses to restore a previously attended cancellation', async () => {
    query.limit.mockResolvedValueOnce([{ doctorId: 'doctor' }]).mockResolvedValueOnce([{ id: 'profile' }]);
    await lifecycle.lockPaymentDoctor(tx as never, 'order');
    expect(query.for).toHaveBeenCalledWith('update');
    vi.mocked(store.attendanceForAppointment).mockResolvedValue(attendance as never);
    await expect(lifecycle.canRestoreCancelledBooking(tx as never, booking.id)).resolves.toBe(false);
    vi.mocked(store.attendanceForAppointment).mockResolvedValue(undefined);
    await expect(lifecycle.canRestoreCancelledBooking(tx as never, booking.id)).resolves.toBe(true);
  });

  it.each(['waiting', 'in_service', 'completed', 'cancelled', 'no_show'])('blocks rescheduling attendance in state %s', async status => {
    vi.mocked(store.attendanceForAppointment).mockResolvedValue({ ...attendance, status } as never);
    await expect(lifecycle.assertReschedulable(tx as never, booking)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('versions both affected dates in deterministic order without allocating tokens', async () => {
    const later = { ...booking, startsAt: new Date('2026-11-17T04:00:00Z') };
    await lifecycle.bookingChanged(tx as never, [later, booking, later], now);
    expect(store.lockDailyQueue).toHaveBeenNthCalledWith(1, tx, 'doctor', '2026-11-16', 'UTC', now, false);
    expect(store.lockDailyQueue).toHaveBeenNthCalledWith(2, tx, 'doctor', '2026-11-17', 'UTC', now, false);
    expect(store.bumpQueueVersion).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('ignores unpaid holds when calculating expected arrivals', async () => {
    await lifecycle.bookingChanged(tx as never, [{ ...booking, status: 'pending_payment' }]);
    expect(store.lockDailyQueue).not.toHaveBeenCalled();
  });

  it('versions the existing frozen timezone bucket instead of moving it to the current schedule timezone', async () => {
    vi.mocked(store.queuesForBooking).mockResolvedValue([{ id: 'old-queue', doctorId: 'doctor', serviceDate: '2026-11-15', timezone: 'America/New_York' }] as never);
    await lifecycle.bookingChanged(tx as never, [booking], now);
    expect(store.lockDailyQueue).toHaveBeenCalledWith(tx, 'doctor', '2026-11-15', 'America/New_York', now, false);
    expect(store.queueTimezone).not.toHaveBeenCalled();
  });

  it('preserves legacy completion but rejects completion of a checked-in waiting patient', async () => {
    await lifecycle.completed(tx as never, booking, 'doctor');
    expect(store.bumpQueueVersion).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
    vi.mocked(store.attendanceForAppointment).mockResolvedValue({ ...attendance, status: 'waiting' } as never);
    await expect(lifecycle.completed(tx as never, booking, 'doctor')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('completes active attendance and audits it in the caller’s transaction', async () => {
    vi.mocked(store.attendanceForAppointment).mockResolvedValue(attendance as never);
    await lifecycle.completed(tx as never, booking, 'doctor');
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', terminalAt: now, terminalBy: 'doctor' }));
    const values = update.set.mock.calls[0][0];
    expect(new PgDialect().sqlToQuery(values.version).sql).toContain('"appointment_attendance"."version" + 1');
    expect(values).not.toHaveProperty('tokenNumber');
    expect(store.bumpQueueVersion).toHaveBeenCalledWith(tx, 'queue', now);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'in_service'])('cancels %s attendance without renumbering a token or changing payment state', async status => {
    vi.mocked(store.attendanceForAppointment).mockResolvedValue({ ...attendance, status } as never);
    await lifecycle.cancelled(tx as never, booking, 'patient');
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled', terminalBy: 'patient' }));
    expect(update.set.mock.calls[0][0]).not.toHaveProperty('tokenNumber');
    expect(store.bumpQueueVersion).toHaveBeenCalledTimes(1);
  });

  it('requires the exact queue version before starting and never changes another appointment', async () => {
    await expect(lifecycle.start(tx as never, { ...attendance, status: 'waiting' } as never, 'doctor', 6, now)).rejects.toBeInstanceOf(ConflictException);
    expect(store.bumpQueueVersion).not.toHaveBeenCalled();
    await lifecycle.start(tx as never, { ...attendance, status: 'waiting' } as never, 'doctor', 7, now);
    expect(query.for).toHaveBeenCalledWith('update');
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_service', startedBy: 'doctor', startedAt: now }));
  });

  it('marks absence without a token and suppresses reminders in the same transaction', async () => {
    await lifecycle.noShow(tx as never, booking, 'UTC', 'staff', now, 'Did not arrive');
    expect(tx.insert.mock.results[0].value.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'no_show', terminalBy: 'staff' }));
    expect(tx.insert.mock.results[0].value.values.mock.calls[0][0]).not.toHaveProperty('tokenNumber');
    expect(reminders.cancelForAppointment).toHaveBeenCalledWith(tx, booking.id);
  });
});

describe('existing appointment write integration', () => {
  let responses: unknown[][];
  const query = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), for: vi.fn().mockReturnThis(), limit: vi.fn() };
  const update = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), returning: vi.fn() };
  const tx = { select: vi.fn(() => { query.limit.mockResolvedValue(responses.shift() ?? []); return query; }), update: vi.fn(() => update) };
  const hooks = { completed: vi.fn(), cancelled: vi.fn(), assertReschedulable: vi.fn(), bookingChanged: vi.fn() };
  const payments = { refundPayment: vi.fn() };
  const service = new AppointmentsService({ isApproved: async () => true } as never, undefined, undefined, payments as never,
    undefined, undefined, undefined, hooks as never);
  const doctor = { id: 'doctor', name: 'Doctor', email: 'doctor@example.test', role: 'doctor' as const };
  beforeEach(() => {
    vi.clearAllMocks(); responses = [];
    for (const hook of Object.values(hooks)) hook.mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation(async callback => callback(tx as never));
    update.returning.mockResolvedValue([{ ...booking, status: 'completed' }]);
    payments.refundPayment.mockResolvedValue({ status: 'processed' });
  });

  it('requires attendance completion before committing appointment completion', async () => {
    responses.push([booking]);
    await service.complete(booking.id, doctor);
    expect(hooks.completed).toHaveBeenCalledWith(tx, booking, 'doctor');
    expect(hooks.completed.mock.invocationCallOrder[0]).toBeLessThan(tx.update.mock.invocationCallOrder[0]);
    responses.push([booking]); hooks.completed.mockRejectedValueOnce(new ConflictException()); tx.update.mockClear();
    await expect(service.complete(booking.id, doctor)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('keeps cancellation and attendance atomic and refunds only after transaction completion', async () => {
    const trace: string[] = [];
    responses.push([{ id: 'payment', status: 'captured', amountPaise: 50000, refundedAmountPaise: 0 }], [booking]);
    hooks.cancelled.mockImplementationOnce(async () => { trace.push('attendance'); });
    vi.mocked(db.transaction).mockImplementationOnce(async callback => { const result = await callback(tx as never); trace.push('commit'); return result; });
    payments.refundPayment.mockImplementationOnce(async () => { trace.push('refund'); return { status: 'processed' }; });
    await service.cancel(booking.id, { ...doctor, id: 'patient', role: 'patient' });
    expect(trace).toEqual(['attendance', 'commit', 'refund']);
    expect(payments.refundPayment).toHaveBeenCalledWith('patient', 'system', 'payment', expect.objectContaining({ amountPaise: 50000 }));
  });

  it('rejects direct rescheduling before touching booking times', async () => {
    responses.push([{ doctorId: 'doctor' }], [{}], [booking]);
    hooks.assertReschedulable.mockRejectedValueOnce(new ConflictException());
    await expect(service.reschedule(booking.id, doctor, { startsAt: new Date('2026-11-17T04:00:00Z'), endsAt: new Date('2026-11-17T04:30:00Z') }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(hooks.assertReschedulable).toHaveBeenCalledWith(tx, booking);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('also guards approved schedule-change consent before applying an alternative', async () => {
    responses.push([{ appointmentId: booking.id }], [{ doctorId: 'doctor' }], [{}],
      [{ id: 'request', doctorId: 'doctor', status: 'pending', approvedAt: new Date(), expiresAt: new Date(Date.now() + 600000) }],
      [{ id: 'affected', appointmentId: booking.id, consentStatus: 'pending', resolutionStatus: 'pending', originalStartsAt: booking.startsAt, originalEndsAt: booking.endsAt }],
      [], [booking]);
    hooks.assertReschedulable.mockRejectedValueOnce(new ConflictException());
    await expect(service.acceptScheduleChange('request', 'affected', 'alternative', 'patient')).rejects.toBeInstanceOf(ConflictException);
    expect(hooks.assertReschedulable).toHaveBeenCalledWith(tx, booking);
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe('explicit no-show configuration', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries({ DATABASE_URL: 'postgresql://test:test@localhost/test', BETTER_AUTH_URL: 'http://localhost:5000',
      FRONTEND_URL: 'http://localhost:3000', BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
      RAZORPAY_KEY_ID: 'test', RAZORPAY_KEY_SECRET: 'test', RAZORPAY_WEBHOOK_SECRET: 'test' })) vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('has no implicit grace and rejects blank, negative or fractional minute values', () => {
    vi.stubEnv('QUEUE_NO_SHOW_GRACE_MINUTES', undefined);
    expect(loadEnv().queueNoShowGraceMinutes).toBeUndefined();
    vi.stubEnv('QUEUE_NO_SHOW_GRACE_MINUTES', '15');
    expect(loadEnv().queueNoShowGraceMinutes).toBe(15);
    for (const value of ['', '-1', '1441', '1.5', 'invalid']) {
      vi.stubEnv('QUEUE_NO_SHOW_GRACE_MINUTES', value);
      expect(() => loadEnv()).toThrow('QUEUE_NO_SHOW_GRACE_MINUTES');
    }
  });
});
