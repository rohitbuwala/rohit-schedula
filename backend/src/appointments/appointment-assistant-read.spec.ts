import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { db } from '../db/database.js';
import { appointment } from '../db/schema.js';
import { AppointmentsService } from './appointments.service.js';

vi.mock('../db/database.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

const doctor: AuthenticatedUser = { id: 'doctor-a', role: 'doctor', name: 'Doctor', email: 'doctor@example.test' };
const patient: AuthenticatedUser = { ...doctor, id: 'patient-a', role: 'patient' };

describe('assistant appointment reads', () => {
  const isApproved = vi.fn();
  const reconciliation = { reconcilePendingRefund: vi.fn() };
  const payments = { refundPayment: vi.fn(), verifyPayment: vi.fn(), createOrder: vi.fn() };
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    groupBy: vi.fn(),
  };
  const getScheduleConfigForDoctor = vi.fn();
  const service = new AppointmentsService(
    { isApproved } as never, { getScheduleConfigForDoctor } as never, undefined, payments as never, reconciliation as never,
  );
  const dialect = new PgDialect();

  beforeEach(() => {
    vi.clearAllMocks();
    isApproved.mockResolvedValue(true);
    vi.mocked(db.select).mockReturnValue(query as never);
    query.limit.mockResolvedValue([]);
  });

  afterEach(() => {
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(reconciliation.reconcilePendingRefund).not.toHaveBeenCalled();
    for (const method of Object.values(payments)) expect(method).not.toHaveBeenCalled();
  });

  it('scopes patient history to the session owner and selects no payment fields', async () => {
    await service.listMineReadOnly(patient);
    expect(query.from).toHaveBeenCalledWith(appointment);
    const predicate = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(predicate.sql).toContain('"appointment"."patient_id"');
    expect(predicate.params).toEqual([patient.id]);
    expect(Object.keys(vi.mocked(db.select).mock.calls[0][0] ?? {}))
      .toEqual(['id', 'startsAt', 'endsAt', 'status', 'doctor', 'period']);
  });

  it('reads only the session patient’s payment and matching refund summaries', async () => {
    const row = { appointmentStartsAt: new Date(), doctorName: 'Dr. Test', amountPaise: 45000,
      currency: 'INR', paymentStatus: 'captured', refundStatus: 'pending' };
    query.limit.mockResolvedValueOnce(Array.from({ length: 51 }, () => row));
    await expect(service.listPatientPaymentHistory(patient)).resolves.toEqual({
      payments: Array.from({ length: 50 }, () => row), hasMore: true,
    });
    expect(dialect.sqlToQuery(query.where.mock.calls[0][0]).params).toEqual([patient.id]);
    expect(dialect.sqlToQuery(query.innerJoin.mock.calls[0][1]).sql)
      .toContain('"appointment"."patient_id" = "payment"."patient_id"');
    const fields = vi.mocked(db.select).mock.calls[0][0] ?? {};
    expect(Object.keys(fields)).toEqual(['appointmentStartsAt', 'doctorName', 'amountPaise', 'currency', 'paymentStatus', 'refundStatus']);
    expect(dialect.sqlToQuery((fields as { refundStatus: Parameters<PgDialect['sqlToQuery']>[0] }).refundStatus).sql)
      .toContain('"refund"."patient_id" = "payment"."patient_id"');
    await expect(service.listPatientPaymentHistory(doctor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).toHaveBeenCalledOnce();
  });

  it('reads prescriptions by the session patient and returns only issued medication information', async () => {
    const issuedAt = new Date('2026-11-12T09:00:00Z');
    query.limit.mockResolvedValueOnce([{
      issuedAt, doctorName: 'Dr. Test', patientId: 'private',
      medications: [{ name: 'Recorded medication', instructions: 'Recorded instructions', internalNote: 'private' }],
    }]);
    await expect(service.listPatientPrescriptions(patient)).resolves.toEqual({
      prescriptions: [{ issuedAt, doctorName: 'Dr. Test', medications: [{ name: 'Recorded medication', instructions: 'Recorded instructions' }] }],
      hasMore: false,
    });
    const predicate = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(predicate.sql).toContain('"appointment"."patient_id"');
    expect(predicate.params).toEqual([patient.id]);
    expect(query.limit).toHaveBeenCalledWith(51);
    await expect(service.listPatientPrescriptions(doctor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).toHaveBeenCalledOnce();
  });

  it.each(['upcoming', 'past'] as const)('scopes %s before limiting results', async (filter) => {
    await service.listMineReadOnly(patient, { filter });
    const predicate = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(predicate.params[0]).toBe(patient.id);
    expect(predicate.params).toContain('scheduled');
    expect(predicate.params).toContain('pending_payment');
    expect(predicate.sql).toContain('"appointment"."patient_id"');
    expect(predicate.sql).toContain('"appointment"."hold_expires_at" is not null');
    expect(predicate.sql.includes('not (')).toBe(filter === 'past');
    expect(query.limit).toHaveBeenCalledWith(51);
    const order = dialect.sqlToQuery(query.orderBy.mock.calls[0][0]);
    expect(order.sql).toContain(filter === 'past' ? 'desc' : 'asc');
  });

  it('bounds the approved doctor query by local midnight and the next local midnight', async () => {
    const day = { date: '2026-11-01', timezone: 'America/New_York' };
    await service.listMineReadOnly(doctor, day);
    const predicate = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(predicate.sql).toContain('"appointment"."doctor_id"');
    expect(predicate.sql).toMatch(/"starts_at" >= .*AT TIME ZONE.*"starts_at" < .*AT TIME ZONE/);
    expect(predicate.params).toEqual([doctor.id, day.date, day.timezone, day.date, day.timezone]);
  });

  it('returns the same not-found response for another doctor’s or a missing appointment', async () => {
    await expect(service.getMineReadOnly('foreign-appointment', doctor)).rejects.toBeInstanceOf(NotFoundException);
    const predicate = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(predicate.sql).toContain('"appointment"."doctor_id"');
    expect(predicate.params).toEqual(['foreign-appointment', doctor.id]);
    expect(Object.keys(vi.mocked(db.select).mock.calls[0][0] ?? {})).toEqual(['id', 'startsAt', 'endsAt', 'status']);
  });

  it('rejects unapproved doctors before accessing appointments', async () => {
    isApproved.mockResolvedValue(false);
    await expect(service.getMineReadOnly('any-appointment', doctor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('aggregates all rows for the approved doctor and includes zero counts', async () => {
    const day = { date: '2026-11-01', timezone: 'America/New_York' };
    query.groupBy.mockResolvedValue([{ status: 'scheduled', count: 53 }, { status: 'completed', count: 2 }]);
    await expect(service.countDoctorAppointmentsByStatus(doctor, day)).resolves.toEqual({
      total: 55, byStatus: { scheduled: 53, completed: 2, cancelled: 0, pending_payment: 0 },
    });
    expect(query.groupBy).toHaveBeenCalledWith(appointment.status);
    expect(query.limit).not.toHaveBeenCalled();
    expect(dialect.sqlToQuery(query.where.mock.calls[0][0]).params)
      .toEqual([doctor.id, day.date, day.timezone, day.date, day.timezone]);
  });

  it('rejects statistics for patients and unapproved doctors before querying', async () => {
    const day = { date: '2026-11-01', timezone: 'Asia/Kolkata' };
    isApproved.mockResolvedValue(false);
    await expect(service.countDoctorAppointmentsByStatus(patient, day)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.countDoctorAppointmentsByStatus(doctor, day)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('finds the earliest slot after breaks, appointments, live holds, leave and days off', async () => {
    const now = new Date('2026-11-12T04:45Z');
    getScheduleConfigForDoctor.mockResolvedValue({
      timezone: 'Asia/Kolkata', activeDays: [1, 4, 5], startHour: 9, endHour: 12, slotDurationMinutes: 15,
      breakStart: '10:30', breakEnd: '11:00', leaveDates: ['2026-11-13'],
    });
    const busy = [
      { startsAt: new Date('2026-11-12T05:30Z'), endsAt: new Date('2026-11-12T06:15Z'), status: 'scheduled' },
      { startsAt: new Date('2026-11-12T06:15Z'), endsAt: new Date('2026-11-12T06:30Z'), status: 'pending_payment',
        holdExpiresAt: new Date('2026-11-12T05:00Z') },
      { startsAt: new Date('2026-11-16T03:30Z'), endsAt: new Date('2026-11-16T03:45Z'), status: 'pending_payment',
        holdExpiresAt: new Date('2026-11-12T04:30Z') },
    ];
    query.where.mockResolvedValueOnce(busy).mockResolvedValueOnce(busy);
    await expect(service.findNextDoctorSlot(doctor, 5, now)).resolves.toEqual({
      timezone: 'Asia/Kolkata', slot: { startsAt: new Date('2026-11-16T03:30Z'), endsAt: new Date('2026-11-16T03:45Z') },
    });
    await expect(service.findNextDoctorSlot(doctor, 4, now)).resolves.toEqual({ timezone: 'Asia/Kolkata', slot: null });
    expect(getScheduleConfigForDoctor).toHaveBeenCalledWith(doctor.id);
    expect(dialect.sqlToQuery(query.where.mock.calls[0][0]).params[0]).toBe(doctor.id);
    expect(Object.keys(vi.mocked(db.select).mock.calls[0][0] ?? {})).toEqual(['startsAt', 'endsAt', 'status', 'holdExpiresAt']);
  });

  it('rejects next-slot queries for patients and unapproved doctors', async () => {
    isApproved.mockResolvedValue(false);
    await expect(service.findNextDoctorSlot(patient)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.findNextDoctorSlot(doctor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(getScheduleConfigForDoctor).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('suggests three open slots without freeing the selected slot or a payment hold', async () => {
    const selected = { id: 'selected', status: 'scheduled', startsAt: new Date('2026-11-12T09:00Z'), endsAt: new Date('2026-11-12T09:30Z') };
    const now = new Date('2026-11-12T08:00Z');
    getScheduleConfigForDoctor.mockResolvedValue({
      timezone: 'UTC', startHour: 9, endHour: 13, breakStart: '10:30', breakEnd: '11:00', slotDurationMinutes: 30,
    });
    query.limit.mockResolvedValueOnce([selected]);
    query.where.mockReturnValueOnce(query).mockResolvedValueOnce([
      selected,
      { status: 'pending_payment', startsAt: new Date('2026-11-12T09:30Z'), endsAt: new Date('2026-11-12T10:00Z'),
        holdExpiresAt: new Date('2026-11-12T08:05Z') },
    ]);
    const result = await service.suggestDoctorRescheduleSlots(doctor, selected.id, now);
    expect(result.timezone).toBe('UTC');
    expect(result.slots).toEqual([
      { startsAt: new Date('2026-11-12T10:00Z'), endsAt: new Date('2026-11-12T10:30Z') },
      { startsAt: new Date('2026-11-12T11:00Z'), endsAt: new Date('2026-11-12T11:30Z') },
      { startsAt: new Date('2026-11-12T11:30Z'), endsAt: new Date('2026-11-12T12:00Z') },
    ]);
    expect(dialect.sqlToQuery(query.where.mock.calls[0][0]).params).toEqual([selected.id, doctor.id]);
  });

  it('rejects unassigned and nonscheduled appointments before checking availability', async () => {
    await expect(service.suggestDoctorRescheduleSlots(doctor, 'foreign')).rejects.toBeInstanceOf(NotFoundException);
    query.limit.mockResolvedValueOnce([{ status: 'completed' }]);
    await expect(service.suggestDoctorRescheduleSlots(doctor, 'completed')).rejects.toBeInstanceOf(ConflictException);
    expect(getScheduleConfigForDoctor).not.toHaveBeenCalled();
  });

  it('scopes patient reschedule options to the session patient before reading any schedule', async () => {
    await expect(service.suggestPatientRescheduleSlots(patient, 'foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(dialect.sqlToQuery(query.where.mock.calls[0][0]).params).toEqual(['foreign', patient.id]);
    expect(getScheduleConfigForDoctor).not.toHaveBeenCalled();
  });

  it('lists only the patient’s scheduled appointments with approved doctors for rescheduling', async () => {
    await service.listMineReadOnly(patient, { filter: 'reschedulable' });
    expect(dialect.sqlToQuery(query.where.mock.calls[0][0]).params).toEqual([patient.id, 'scheduled', 'approved']);
    expect(query.limit).toHaveBeenCalledWith(51);
  });

  it('suggests available slots for the doctor on the patient’s scheduled appointment', async () => {
    const startsAt = new Date('2027-01-04T09:00:00Z');
    const endsAt = new Date('2027-01-04T09:30:00Z');
    query.limit.mockResolvedValueOnce([{ doctorId: doctor.id, startsAt, status: 'scheduled' }]);
    query.where.mockReturnValueOnce(query).mockResolvedValueOnce([{ startsAt, endsAt, status: 'scheduled' }]);
    getScheduleConfigForDoctor.mockResolvedValue({ timezone: 'UTC', activeDays: [1], startHour: 9, endHour: 12, slotDurationMinutes: 30 });
    const result = await service.suggestPatientRescheduleSlots(patient, 'own', new Date('2027-01-04T08:00:00Z'));
    expect(result).toMatchObject({ currentStartsAt: startsAt, timezone: 'UTC' });
    expect(result.slots).toHaveLength(3);
    expect(result.slots[0].startsAt).toEqual(endsAt);
    expect(getScheduleConfigForDoctor).toHaveBeenCalledWith(doctor.id);
  });
});
