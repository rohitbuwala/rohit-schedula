import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AppointmentQueueService } from './appointment-queue.service.js';
import * as store from './appointment-queue-store.js';

vi.mock('./appointment-queue-store.js', () => ({
  queueTransaction: vi.fn(), queueAppointment: vi.fn(), attendanceForAppointment: vi.fn(), queueTimezone: vi.fn(),
  bookingTokenForAppointment: vi.fn(), lockDailyQueue: vi.fn(), bumpQueueVersion: vi.fn(), allocateQueueToken: vi.fn(), insertCheckIn: vi.fn(), ownAttendanceRows: vi.fn(), dailyQueue: vi.fn(), readQueuePage: vi.fn(),
  firstWaiting: vi.fn(), currentAttendance: vi.fn(),
}));
vi.mock('../config/env.js', () => ({ loadEnv: vi.fn() }));
vi.mock('../db/database.js', () => ({ db: {} }));
const id = '00000000-0000-4000-8000-000000000001';
const doctor: AuthenticatedUser = { id: 'doctor', name: 'Doctor', email: 'doctor@example.test', role: 'doctor' };
const staff: AuthenticatedUser = { ...doctor, id: 'staff', role: 'staff' };
const patient: AuthenticatedUser = { ...doctor, id: 'patient', role: 'patient' };
const now = new Date('2026-11-16T04:00:00Z');
const booking = { id, doctorId: 'doctor', patientId: 'patient', status: 'scheduled' as const, startsAt: new Date('2026-11-16T04:30:00Z'), endsAt: new Date('2026-11-16T05:00:00Z') };
const attendance = { appointmentId: id, doctorId: 'doctor', queueId: 'queue', appointmentStartsAt: booking.startsAt,
  tokenNumber: 7, status: 'waiting' as const, checkedInAt: now, checkedInBy: 'staff', version: 1 };

describe('queue service boundaries and check-in orchestration', () => {
  const assigned = vi.fn();
  const lifecycle = { start: vi.fn(), noShow: vi.fn() };
  const service = new AppointmentQueueService({ assertAssigned: assigned } as never, lifecycle as never);
  const query = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), for: vi.fn().mockReturnThis(), limit: vi.fn() };
  const tx = { select: vi.fn(() => query) };
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
    assigned.mockResolvedValue(undefined); query.limit.mockResolvedValue([{ id: 'authorized' }]);
    vi.mocked(store.queueTransaction).mockImplementation(async callback => callback(tx as never));
    vi.mocked(store.queueAppointment).mockResolvedValue(booking);
    vi.mocked(store.attendanceForAppointment).mockResolvedValue(undefined);
    vi.mocked(store.queueTimezone).mockResolvedValue('Asia/Kolkata');
    vi.mocked(store.bookingTokenForAppointment).mockResolvedValue({ appointmentId: id, doctorId: 'doctor', queueId: 'queue', appointmentStartsAt: booking.startsAt, tokenNumber: 7, timezone: 'Asia/Kolkata', serviceDate: '2026-11-16' } as never);
    vi.mocked(store.lockDailyQueue).mockResolvedValue({ id: 'queue' } as never);
    vi.mocked(store.bumpQueueVersion).mockResolvedValue(8);
    vi.mocked(store.allocateQueueToken).mockResolvedValue({ tokenNumber: 7, queueVersion: 7, queue: { id: 'queue' } } as never);
    vi.mocked(store.ownAttendanceRows).mockResolvedValue([{ appointmentId: id, bookingStatus: 'scheduled', attendance,
      position: 2, queue: { serviceDate: '2026-11-16', timezone: 'Asia/Kolkata', version: 7 } }] as never);
    vi.mocked(store.dailyQueue).mockResolvedValue({ id: 'queue', version: 7, timezone: 'Asia/Kolkata' } as never);
    vi.mocked(store.readQueuePage).mockResolvedValue({ current: null, waiting: [], waitingCount: 0, expected: [] });
    vi.mocked(store.firstWaiting).mockResolvedValue({ appointmentId: id });
    vi.mocked(store.currentAttendance).mockResolvedValue(undefined);
    vi.mocked(loadEnv).mockReturnValue({ queueNoShowGraceMinutes: 15 } as never);
    lifecycle.start.mockResolvedValue(undefined); lifecycle.noShow.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('authorizes staff and checks in using the existing booking token without allocating', async () => {
    await expect(service.checkIn(staff, id)).resolves.toMatchObject({ tokenNumber: 7, position: 2, version: 1, queueVersion: 7 });
    expect(assigned).toHaveBeenCalledWith(tx, staff, 'doctor');
    expect(store.queueAppointment).toHaveBeenNthCalledWith(2, tx, id, true);
    expect(vi.mocked(store.queueAppointment).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(store.lockDailyQueue).mock.invocationCallOrder[0]);
    expect(store.insertCheckIn).toHaveBeenCalledWith(tx, expect.objectContaining({ status: 'waiting', tokenNumber: 7, checkedInBy: 'staff', checkedInAt: now }), 'staff', now);
    expect(store.queueTransaction).toHaveBeenCalledWith(expect.any(Function), true);
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
  });

  it('returns the original token/time without allocating or writing on a duplicate, including after midnight', async () => {
    vi.mocked(store.attendanceForAppointment).mockResolvedValue(attendance as never);
    vi.setSystemTime(new Date('2026-11-17T04:00:00Z'));
    await expect(service.checkIn(doctor, id)).resolves.toMatchObject({ tokenNumber: 7, checkedInAt: now });
    expect(store.allocateQueueToken).not.toHaveBeenCalled(); expect(store.insertCheckIn).not.toHaveBeenCalled();
    expect(store.queueTimezone).not.toHaveBeenCalled();
  });

  it('never invents a new token at check-in if the booking token is missing or stale', async () => {
    vi.mocked(store.bookingTokenForAppointment).mockResolvedValueOnce(undefined);
    await expect(service.checkIn(staff, id)).rejects.toBeInstanceOf(ConflictException);
    vi.mocked(store.bookingTokenForAppointment).mockResolvedValueOnce({ doctorId: 'doctor', appointmentStartsAt: now } as never);
    await expect(service.checkIn(staff, id)).rejects.toBeInstanceOf(ConflictException);
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
    expect(store.insertCheckIn).not.toHaveBeenCalled();
  });

  it('shows the reserved booking token before arrival, without assigning a position or check-in time', async () => {
    vi.mocked(store.ownAttendanceRows).mockResolvedValue([{ appointmentId: id, bookingStatus: 'scheduled',
      bookingTokenNumber: 12, currentTokenNumber: 4, attendance: null, position: null,
      queue: { serviceDate: '2026-11-16', timezone: 'Asia/Kolkata', version: 7 } }] as never);
    await expect(service.ownAttendance(patient, [id])).resolves.toMatchObject({ appointments: [
      { status: 'not_checked_in', tokenNumber: 12, currentTokenNumber: 4, position: null, checkedInAt: null },
    ] });
  });

  it('keeps a cancelled unarrived booking closed while preserving its reserved token', async () => {
    vi.mocked(store.ownAttendanceRows).mockResolvedValue([{ appointmentId: id, bookingStatus: 'cancelled',
      bookingTokenNumber: 12, currentTokenNumber: 4, attendance: null, position: null, queue: null }] as never);
    await expect(service.ownAttendance(patient, [id])).resolves.toMatchObject({ appointments: [
      { status: 'cancelled', tokenNumber: 12, currentTokenNumber: null, position: null },
    ] });
  });

  it('rejects non-operational roles, cross-doctor appointments and revoked staff access', async () => {
    for (const role of ['patient', 'admin'] as const) await expect(service.checkIn({ ...patient, role }, id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.checkIn({ ...doctor, id: 'other' }, id)).rejects.toBeInstanceOf(NotFoundException);
    assigned.mockRejectedValue(new NotFoundException());
    await expect(service.checkIn(staff, id)).rejects.toBeInstanceOf(NotFoundException);
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
  });

  it('checks current approval and rejects missing or changed appointments', async () => {
    query.limit.mockResolvedValue([]);
    await expect(service.checkIn(doctor, id)).rejects.toBeInstanceOf(ForbiddenException);
    vi.mocked(store.queueAppointment).mockResolvedValueOnce(undefined);
    await expect(service.checkIn(staff, id)).rejects.toBeInstanceOf(NotFoundException);
    vi.mocked(store.queueAppointment).mockResolvedValueOnce(booking).mockResolvedValueOnce({ ...booking, doctorId: 'changed' });
    await expect(service.checkIn(staff, id)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each(['pending_payment', 'cancelled', 'completed'] as const)('does not check in a %s booking', async status => {
    vi.mocked(store.queueAppointment).mockResolvedValue({ ...booking, status });
    await expect(service.checkIn(staff, id)).rejects.toBeInstanceOf(ConflictException);
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
  });

  it('does not revive terminal or rescheduled attendance', async () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) {
      vi.mocked(store.attendanceForAppointment).mockResolvedValue({ ...attendance, status } as never);
      await expect(service.checkIn(staff, id)).rejects.toBeInstanceOf(ConflictException);
    }
    vi.mocked(store.attendanceForAppointment).mockResolvedValue({ ...attendance, appointmentStartsAt: now } as never);
    await expect(service.checkIn(staff, id)).rejects.toBeInstanceOf(ConflictException);
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
  });

  it('returns only the patient’s attendance summary and rejects mixed missing/foreign identifiers', async () => {
    const response = await service.ownAttendance(patient, [id]);
    expect(store.ownAttendanceRows).toHaveBeenCalledWith(tx, patient.id, [id]);
    const serialized = JSON.stringify(response);
    for (const forbidden of ['checkedInBy', 'patientName', 'doctorId', 'queueId', 'email']) expect(serialized).not.toContain(forbidden);
    await expect(service.ownAttendance(staff, [id])).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.ownAttendance(patient, [id, 'missing'])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('represents unchecked and cancelled appointments without a stale waiting position', async () => {
    vi.mocked(store.ownAttendanceRows).mockResolvedValue([{ appointmentId: id, bookingStatus: 'scheduled', attendance: null, position: null, queue: null }] as never);
    await expect(service.ownAttendance(patient, [id])).resolves.toMatchObject({ appointments: [{ status: 'not_checked_in', tokenNumber: null, position: null }] });
    vi.mocked(store.ownAttendanceRows).mockResolvedValue([{ appointmentId: id, bookingStatus: 'cancelled', attendance, position: 2, queue: null }] as never);
    await expect(service.ownAttendance(patient, [id])).resolves.toMatchObject({ appointments: [{ status: 'cancelled', position: null }] });
  });

  it('distinguishes the own token from the serving token and exposes saved completion time', async () => {
    const row = { appointmentId: id, bookingStatus: 'scheduled', attendance, position: 2,
      currentTokenNumber: 3, queue: { serviceDate: '2026-11-16', timezone: 'Asia/Kolkata', version: 7 } };
    vi.mocked(store.ownAttendanceRows).mockResolvedValue([row] as never);
    await expect(service.ownAttendance(patient, [id])).resolves.toMatchObject({ appointments: [
      { tokenNumber: 7, currentTokenNumber: 3, completedAt: null },
    ] });
    const terminalAt = new Date('2026-11-16T05:12:00Z');
    vi.mocked(store.ownAttendanceRows).mockResolvedValue([{ ...row, bookingStatus: 'completed',
      attendance: { ...attendance, status: 'completed', startedAt: now, terminalAt } }] as never);
    await expect(service.ownAttendance(patient, [id])).resolves.toMatchObject({ appointments: [
      { tokenNumber: 7, currentTokenNumber: null, position: null, startedAt: now, completedAt: terminalAt },
    ] });
  });

  it('rejects stale pagination versions and scopes operational reads to the assigned doctor', async () => {
    await expect(service.read(staff, { doctorId: 'doctor', date: '2026-11-16', limit: 10, cursor: '6:10' })).rejects.toBeInstanceOf(ConflictException);
    expect(store.readQueuePage).not.toHaveBeenCalled();
    vi.mocked(store.readQueuePage).mockResolvedValue({ current: null, waiting: Array(11).fill({ tokenNumber: 7 }), waitingCount: 20, expected: [] } as never);
    await expect(service.read(staff, { doctorId: 'doctor', date: '2026-11-16', limit: 10, cursor: '7:0' }))
      .resolves.toMatchObject({ version: 7, nextCursor: '7:10', hasMoreWaiting: true, hasMoreExpected: false });
    expect(store.allocateQueueToken).not.toHaveBeenCalled(); expect(store.insertCheckIn).not.toHaveBeenCalled();
  });

  it('does not create a queue just to read an empty service date', async () => {
    vi.mocked(store.dailyQueue).mockResolvedValue(undefined);
    await expect(service.read(doctor, { doctorId: 'doctor', date: '2026-11-16', limit: 50 }))
      .resolves.toMatchObject({ version: 0, current: null, waiting: [], expected: [], nextCursor: null });
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
  });

  it('starts only the booked head of the queue, after locking its appointment', async () => {
    vi.mocked(store.attendanceForAppointment).mockResolvedValue(attendance as never);
    await service.next(doctor, 'doctor', { serviceDate: '2026-11-16', expectedQueueVersion: 7 });
    expect(store.queueAppointment).toHaveBeenCalledWith(tx, id, true);
    expect(lifecycle.start).toHaveBeenCalledWith(tx, attendance, 'doctor', 7, now);
    expect(vi.mocked(store.queueAppointment).mock.invocationCallOrder[0]).toBeLessThan(lifecycle.start.mock.invocationCallOrder[0]);
    await expect(service.next(staff, 'doctor', { serviceDate: '2026-11-16', expectedQueueVersion: 7 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not advance a stale, active, empty or changed queue', async () => {
    const input = { serviceDate: '2026-11-16', expectedQueueVersion: 7 };
    await expect(service.next(doctor, 'doctor', { ...input, expectedQueueVersion: 6 })).rejects.toBeInstanceOf(ConflictException);
    vi.mocked(store.currentAttendance).mockResolvedValueOnce({ appointmentId: 'current' });
    await expect(service.next(doctor, 'doctor', input)).rejects.toBeInstanceOf(ConflictException);
    vi.mocked(store.firstWaiting).mockResolvedValueOnce(undefined);
    await expect(service.next(doctor, 'doctor', input)).rejects.toBeInstanceOf(ConflictException);
    vi.mocked(store.queueAppointment).mockResolvedValueOnce({ ...booking, status: 'cancelled' });
    await expect(service.next(doctor, 'doctor', input)).rejects.toBeInstanceOf(ConflictException);
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  it('requires the explicitly configured grace period and never marks a checked-in patient absent', async () => {
    await expect(service.noShow(staff, id, {})).rejects.toBeInstanceOf(ConflictException);
    vi.mocked(loadEnv).mockReturnValueOnce({} as never);
    await expect(service.noShow(staff, id, {})).rejects.toBeInstanceOf(ServiceUnavailableException);
    vi.setSystemTime(new Date('2026-11-16T05:00:00Z'));
    vi.mocked(store.attendanceForAppointment).mockResolvedValue(attendance as never);
    await expect(service.noShow(staff, id, {})).rejects.toBeInstanceOf(ConflictException);
    expect(lifecycle.noShow).not.toHaveBeenCalled();
  });

  it('marks an unarrived patient absent without allocating a token and keeps repeat requests idempotent', async () => {
    const absentAt = new Date('2026-11-16T05:00:00Z'); vi.setSystemTime(absentAt);
    await service.noShow(staff, id, { expectedAttendanceVersion: 0, reason: 'Patient did not arrive' });
    expect(lifecycle.noShow).toHaveBeenCalledWith(tx, booking, 'Asia/Kolkata', 'staff', absentAt, 'Patient did not arrive');
    expect(store.allocateQueueToken).not.toHaveBeenCalled();
    vi.mocked(store.attendanceForAppointment).mockResolvedValue({ ...attendance, status: 'no_show', tokenNumber: null } as never);
    await service.noShow(staff, id, {});
    expect(lifecycle.noShow).toHaveBeenCalledTimes(1);
    await expect(service.noShow(staff, id, { expectedAttendanceVersion: 0 })).rejects.toBeInstanceOf(ConflictException);
  });
});
