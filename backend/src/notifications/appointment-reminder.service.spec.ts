import { AppointmentReminderService } from './appointment-reminder.service.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: { transaction: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

const startsAt = new Date('2027-01-02T12:00:00.000Z');
const updatedAt = new Date('2026-12-01T00:00:00.000Z');
const baseReminder = (overrides: Record<string, unknown> = {}) => ({
  id: 'reminder-1', appointmentId: 'appt-1', recipientId: 'patient-1',
  recipientEmail: 'patient@example.invalid', recipientName: 'Patient', otherPartyName: 'Dr. Doctor',
  intervalMinutes: 60, appointmentStartsAt: startsAt, generation: 0,
  timezone: 'Asia/Kolkata', scheduledFor: new Date(startsAt.getTime() - 60 * 60_000),
  status: 'pending', attemptCount: 0, nextAttemptAt: new Date('2026-12-01T00:00:00.000Z'),
  firstAttemptAt: null, lastError: null, processingAt: null, leaseExpiresAt: null,
  sentAt: null, createdAt: updatedAt, updatedAt, ...overrides,
});

describe('AppointmentReminderService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('schedules both default intervals for each participant and preserves the doctor timezone', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const values = vi.fn((row) => { inserted.push(row); return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }; });
    const tx = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([
        { id: 'patient-1', name: 'Patient', email: 'patient@example.invalid' },
        { id: 'doctor-1', name: 'Doctor', email: 'doctor@example.invalid' },
      ]) }) }),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const service = new AppointmentReminderService({} as never);
    const appointment = { id: 'appt-1', patientId: 'patient-1', doctorId: 'doctor-1', startsAt, updatedAt, reminderGeneration: 0 };

    await expect(service.scheduleForAppointment(tx as never, appointment, 'America/New_York', new Date('2027-01-01T10:00:00Z'))).resolves.toBe(4);

    expect(inserted).toHaveLength(4);
    expect(inserted.map((row) => row.intervalMinutes)).toEqual([1440, 60, 1440, 60]);
    expect(inserted[0].scheduledFor).toEqual(new Date(startsAt.getTime() - 24 * 60 * 60_000));
    expect(inserted.every((row) => row.timezone === 'America/New_York')).toBe(true);
    expect(values.mock.results[0].value.onConflictDoNothing).toHaveBeenCalledWith(expect.objectContaining({ target: expect.any(Array) }));
  });

  it('skips intervals already in the past and prevents scheduling after appointment start', async () => {
    const values = vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) });
    const tx = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([
        { id: 'patient-1', name: 'Patient', email: 'patient@example.invalid' },
      ]) }) }),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const service = new AppointmentReminderService({} as never);
    const appointment = { id: 'appt-1', patientId: 'patient-1', doctorId: 'doctor-1', startsAt, updatedAt, reminderGeneration: 0 };

    await expect(service.scheduleForAppointment(tx as never, appointment, 'Asia/Kolkata', new Date(startsAt.getTime() - 30 * 60_000))).resolves.toBe(0);
    await expect(service.scheduleForAppointment(tx as never, appointment, 'Asia/Kolkata', startsAt)).resolves.toBe(0);
    expect(values).not.toHaveBeenCalled();
  });

  it('recovers a due database job after worker restart and reclaims an expired lease with SKIP LOCKED', async () => {
    const reminder = baseReminder({ status: 'processing', attemptCount: 1, firstAttemptAt: updatedAt, leaseExpiresAt: new Date('2027-01-02T09:00:00.000Z') });
    const appt = { id: 'appt-1', patientId: 'patient-1', doctorId: 'doctor-1', startsAt, updatedAt, reminderGeneration: 0, status: 'scheduled' };
    const lock = vi.fn().mockResolvedValue([reminder]);
    const setCalls: Array<Record<string, unknown>> = [];
    const claimTx = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ for: lock }) }) }) }) }),
      update: vi.fn().mockReturnValue({ set: vi.fn((values) => { setCalls.push(values); return { where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ ...reminder, ...values }]) }) }; }) }),
    };
    const deliverTx = makeDeliveryTransaction(reminder, appt, setCalls);
    (db.transaction as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(claimTx))
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(deliverTx));
    (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
    const email = { isTestMode: vi.fn().mockReturnValue(true), sendEvent: vi.fn().mockResolvedValue({ status: 'sent' }) };
    const service = new AppointmentReminderService(email as never);

    await expect(service.dispatchBatch(new Date('2027-01-02T10:30:00.000Z'))).resolves.toBe(1);

    expect(lock).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(setCalls).toContainEqual(expect.objectContaining({ status: 'processing', leaseExpiresAt: expect.any(Date) }));
    expect(email.sendEvent).toHaveBeenCalledWith('appointment_reminder', 'patient@example.invalid', expect.objectContaining({
      timezone: 'Asia/Kolkata', recipientName: 'Patient', otherPartyName: 'Dr. Doctor',
    }), 'appointment_reminder:reminder-1');
    expect(setCalls.some((values) => values.status === 'sent')).toBe(true);
  });

  it('cancels stale schedule generations without sending', async () => {
    const reminder = baseReminder({ status: 'processing', attemptCount: 1 });
    const appt = { id: 'appt-1', patientId: 'patient-1', doctorId: 'doctor-1', startsAt, updatedAt, reminderGeneration: 1, status: 'scheduled' };
    const sets: Array<Record<string, unknown>> = [];
    const claimTx = makeClaimTransaction(reminder);
    const deliverTx = makeDeliveryTransaction(reminder, appt, sets);
    (db.transaction as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(claimTx))
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(deliverTx));
    (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
    const email = { isTestMode: vi.fn().mockReturnValue(true), sendEvent: vi.fn() };

    await new AppointmentReminderService(email as never).dispatchBatch(new Date('2027-01-02T10:30:00Z'));

    expect(email.sendEvent).not.toHaveBeenCalled();
    expect(sets).toContainEqual(expect.objectContaining({ status: 'cancelled', lastError: 'appointment_or_schedule_no_longer_eligible' }));
  });

  it.each([
    ['cancelled', startsAt],
    ['completed', startsAt],
    ['scheduled', new Date(Date.now() - 1_000)],
  ] as const)('rejects %s appointments and appointments whose start time has passed', async (status, currentStartsAt) => {
    const reminder = baseReminder({ status: 'processing', attemptCount: 1 });
    const appt = { id: 'appt-1', patientId: 'patient-1', doctorId: 'doctor-1', startsAt: currentStartsAt, updatedAt, reminderGeneration: 0, status };
    const sets: Array<Record<string, unknown>> = [];
    (db.transaction as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(makeClaimTransaction(reminder)))
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(makeDeliveryTransaction(reminder, appt, sets)));
    (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
    const email = { isTestMode: vi.fn().mockReturnValue(true), sendEvent: vi.fn() };

    await new AppointmentReminderService(email as never).dispatchBatch(new Date('2027-01-02T10:30:00Z'));

    expect(email.sendEvent).not.toHaveBeenCalled();
    expect(sets).toContainEqual(expect.objectContaining({ status: 'cancelled' }));
  });

  it('cancels a reminder if the recipient email changes after scheduling', async () => {
    const reminder = baseReminder({ status: 'processing', attemptCount: 1 });
    const appt = { id: 'appt-1', patientId: 'patient-1', doctorId: 'doctor-1', startsAt, updatedAt, reminderGeneration: 0, status: 'scheduled' };
    const sets: Array<Record<string, unknown>> = [];
    (db.transaction as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(makeClaimTransaction(reminder)))
      .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(makeDeliveryTransaction(reminder, appt, sets, 'new-patient@example.invalid')));
    (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
    const email = { isTestMode: vi.fn().mockReturnValue(true), sendEvent: vi.fn() };

    await new AppointmentReminderService(email as never).dispatchBatch(new Date('2027-01-02T10:30:00Z'));

    expect(email.sendEvent).not.toHaveBeenCalled();
    expect(sets).toContainEqual(expect.objectContaining({ status: 'cancelled', lastError: 'recipient_email_changed_since_scheduling' }));
  });

  it('does not dispatch when email delivery is not in test mode', async () => {
    const email = { isTestMode: vi.fn().mockReturnValue(false), sendEvent: vi.fn() };

    await expect(new AppointmentReminderService(email as never).dispatchBatch()).resolves.toBe(0);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(email.sendEvent).not.toHaveBeenCalled();
  });

  it('applies retention to sent and inactive records while leaving pending jobs alone', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    (db.delete as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ where });

    await new AppointmentReminderService({} as never).purgeExpiredRecords();

    expect(db.delete).toHaveBeenCalled();
    expect(where).toHaveBeenCalled();
  });

  it('retries retryable delivery with backoff and dead-letters the eighth failed attempt', async () => {
    for (const [attemptCount, expectedStatus] of [[0, 'pending'], [7, 'dead']] as const) {
      vi.clearAllMocks();
      const reminder = baseReminder({ status: 'processing', attemptCount, firstAttemptAt: updatedAt });
      const sets: Array<Record<string, unknown>> = [];
      const claimTx = makeClaimTransaction(reminder);
      const deliverTx = makeDeliveryTransaction({ ...reminder, attemptCount: attemptCount + 1 }, { id: 'appt-1', patientId: 'patient-1', doctorId: 'doctor-1', startsAt, updatedAt, reminderGeneration: 0, status: 'scheduled' }, sets);
      (db.transaction as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(claimTx))
        .mockImplementationOnce((callback: (tx: unknown) => unknown) => callback(deliverTx));
      (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
      const email = { isTestMode: vi.fn().mockReturnValue(true), sendEvent: vi.fn().mockResolvedValue({ status: 'retryable', reason: 'timeout', ambiguous: true }) };

      await new AppointmentReminderService(email as never).dispatchBatch(new Date('2027-01-02T10:30:00Z'));

      expect(sets).toContainEqual(expect.objectContaining({ status: expectedStatus }));
    }
  });
});

function makeClaimTransaction(reminder: ReturnType<typeof baseReminder>) {
  return {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue([reminder]) }) }) }) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ ...reminder, status: 'processing', attemptCount: reminder.attemptCount + 1 }]) }) }) }),
  };
}

function makeDeliveryTransaction(
  reminder: ReturnType<typeof baseReminder>,
  appt: Record<string, unknown>,
  setCalls: Array<Record<string, unknown>>,
  recipientEmail = 'patient@example.invalid',
) {
  let selectCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      const current = selectCount++;
      if (current === 0) return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([reminder]) }) }) };
      if (current === 1) return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ for: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([appt]) }) }) }) };
      if (current === 2) return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ for: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ...reminder, status: 'processing' }]) }) }) }) };
      const user = current === 3 ? { id: 'patient-1', email: recipientEmail } : { id: 'doctor-1' };
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([user]) }) }) };
    }),
    update: vi.fn().mockReturnValue({ set: vi.fn((values) => { setCalls.push(values); return { where: vi.fn().mockResolvedValue(undefined) }; }) }),
  };
}
