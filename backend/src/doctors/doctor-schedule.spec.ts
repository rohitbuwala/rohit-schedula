import { DoctorScheduleService } from './doctor-schedule.service.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

function query(result: unknown) {
  const builder: any = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    for: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function setScheduleReads(availability: unknown[], leaves: unknown[] = [], overrides: unknown[] = []) {
  vi.mocked(db.select).mockImplementationOnce(() => query(availability) as never)
    .mockImplementationOnce(() => query(leaves) as never)
    .mockImplementationOnce(() => query(overrides) as never);
}

describe('doctor schedule service persistence', () => {
  const doctorId = 'doctor-123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.transaction).mockImplementation(((callback: (tx: unknown) => unknown) =>
      Promise.resolve(callback({
        select: db.select,
        insert: db.insert,
        update: db.update,
        delete: db.delete,
      }))) as never);
  });

  it('returns existing weekly defaults when the database has no saved schedule', async () => {
    setScheduleReads([], [], []);
    const schedule = await new DoctorScheduleService().getSchedule(doctorId);
    expect(schedule).toMatchObject({
      timezone: 'Asia/Kolkata', activeDays: [1, 2, 3, 4, 5], startHour: 9,
      endHour: 17, slotDurationMinutes: 30, leaves: [], overrides: [],
      schedulingMode: 'stream', capacity: 1,
    });
  });

  it('upserts weekly settings and reloads them from storage in a fresh service instance', async () => {
    const upsert = { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.insert).mockReturnValue(upsert as never);
    const stored = {
      timezone: 'America/New_York', activeDays: [1, 2, 3, 4, 5, 6], schedulingMode: 'wave', capacity: 4,
      startHour: 10, endHour: 18, slotDurationMinutes: 15, breakStart: '13:00', breakEnd: '14:00',
    };
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    setScheduleReads([], [], []); // conflict check
    setScheduleReads([stored], [], []);

    const saved = await new DoctorScheduleService().updateSchedule(doctorId, {
      timezone: stored.timezone, activeDays: stored.activeDays, startHour: 10, endHour: 18,
      slotDurationMinutes: 15, breakStart: '13:00', breakEnd: '14:00',
      schedulingMode: 'wave', capacity: 4,
    });
    expect(upsert.onConflictDoUpdate).toHaveBeenCalled();
    expect(saved).toMatchObject({ ...stored, leaves: [], overrides: [] });

    setScheduleReads([stored], [], []);
    const afterRestart = await new DoctorScheduleService().getSchedule(doctorId);
    expect(afterRestart.timezone).toBe('America/New_York');
    expect(afterRestart.slotDurationMinutes).toBe(15);
    expect(afterRestart.schedulingMode).toBe('wave');
    expect(afterRestart.capacity).toBe(4);
    expect(afterRestart.activeDays).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects a shrink that would remove a future appointment and leaves the schedule unchanged', async () => {
    const update = {
      timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 10, endHour: 11,
      slotDurationMinutes: 30, schedulingMode: 'wave' as const, capacity: 1,
      breakStart: null, breakEnd: null,
    };
    const upsert = { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.insert).mockReturnValue(upsert as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    setScheduleReads([], [], [{
      id: 'appointment-1',
      startsAt: new Date('2027-01-04T11:00:00Z'),
      endsAt: new Date('2027-01-04T11:30:00Z'),
      status: 'scheduled',
    }]); // conflict check

    await expect(new DoctorScheduleService().updateSchedule(doctorId, update)).rejects.toMatchObject({
      response: {
        conflicts: [{ id: 'appointment-1', status: 'scheduled' }],
      },
    });
    expect(upsert.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('creates an affected appointment for a 15-minute booking outside 30-minute Wave slots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T10:00:00.000Z'));

    const request = {
      id: 'request-wave-duration',
      doctorId,
      proposedSchedule: {},
      status: 'pending',
      expiresAt: new Date('2027-01-02T10:00:00.000Z'),
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      expiredAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      createdAt: new Date('2027-01-01T10:00:00.000Z'),
      updatedAt: new Date('2027-01-01T10:00:00.000Z'),
    };
    const affected = {
      id: 'affected-wave-duration',
      requestId: request.id,
      appointmentId: 'appointment-wave-duration',
      originalStartsAt: new Date('2027-01-04T09:00:00.000Z'),
      originalEndsAt: new Date('2027-01-04T09:15:00.000Z'),
      consentStatus: 'pending',
      resolutionStatus: 'pending',
      selectedAlternativeId: null,
      respondedAt: null,
      responseReason: null,
      resolvedAt: null,
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    };
    const insertRequest = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([request]),
    };
    const insertAffected = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([affected]),
    };
    const insertAlternatives = { values: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.insert)
      .mockReturnValueOnce(insertRequest as never)
      .mockReturnValueOnce(insertAffected as never)
      .mockReturnValueOnce(insertAlternatives as never);
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor row lock
      .mockImplementationOnce(() => query([]) as never) // duplicate request check
      .mockImplementationOnce(() => query([]) as never) // leaves
      .mockImplementationOnce(() => query([]) as never) // overrides
      .mockImplementationOnce(() => query([{
        id: affected.appointmentId,
        patientId: 'patient-wave-duration',
        startsAt: affected.originalStartsAt,
        endsAt: affected.originalEndsAt,
        status: 'scheduled',
      }]) as never) // conflicts
      .mockImplementationOnce(() => query([]) as never) // leaves for alternatives
      .mockImplementationOnce(() => query([]) as never) // overrides for alternatives
      .mockImplementationOnce(() => query([]) as never); // occupied alternatives

    try {
      const result = await new DoctorScheduleService().createScheduleRequest(doctorId, {
        timezone: 'UTC',
        activeDays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 10,
        slotDurationMinutes: 30,
        schedulingMode: 'wave',
        capacity: 1,
        breakStart: null,
        breakEnd: null,
      });

      expect(result.hasConflicts).toBe(true);
      expect(result.affectedAppointments).toHaveLength(1);
      expect(insertAffected.values).toHaveBeenCalledWith(expect.objectContaining({
        appointmentId: affected.appointmentId,
        originalEndsAt: affected.originalEndsAt,
      }));
      expect(insertAlternatives.values).toHaveBeenCalled();
      expect(result.affectedAppointments[0]?.alternatives.length).toBeGreaterThan(0);
      for (const alternative of result.affectedAppointments[0]!.alternatives) {
        expect(alternative.endsAt.getTime() - alternative.startsAt.getTime()).toBe(15 * 60_000);
        expect(alternative.startsAt.getTime()).not.toBe(affected.originalStartsAt.getTime());
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows expansion and ignores expired payment holds during conflict checks', async () => {
    const upsert = { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.insert).mockReturnValue(upsert as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    setScheduleReads([], [], []); // conflict check leaves and overrides
    setScheduleReads([{
      timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], schedulingMode: 'wave', capacity: 1,
      startHour: 9, endHour: 12, slotDurationMinutes: 30, breakStart: null, breakEnd: null,
    }], [], []);

    await expect(new DoctorScheduleService().updateSchedule(doctorId, {
      timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 12,
      slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 1,
      breakStart: null, breakEnd: null,
    })).resolves.toMatchObject({ startHour: 9, endHour: 12 });
    expect(upsert.onConflictDoUpdate).toHaveBeenCalled();
  });

  it('rejects a shrink that would remove an active payment hold', async () => {
    const upsert = { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.insert).mockReturnValue(upsert as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    setScheduleReads([], [], [{
      id: 'active-hold',
      startsAt: new Date('2027-01-04T11:00:00Z'),
      endsAt: new Date('2027-01-04T11:30:00Z'),
      status: 'pending_payment',
    }]);

    await expect(new DoctorScheduleService().updateSchedule(doctorId, {
      timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 10, endHour: 11,
      slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 1,
      breakStart: null, breakEnd: null,
    })).rejects.toMatchObject({
      response: {
        conflicts: [{ id: 'active-hold', status: 'pending_payment' }],
      },
    });
    expect(upsert.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('rejects a Wave capacity reduction when existing bookings exceed the proposed capacity', async () => {
    const upsert = { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.insert).mockReturnValue(upsert as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    setScheduleReads([], [], [
      {
        id: 'booking-1',
        patientId: 'patient-1',
        startsAt: new Date('2027-01-04T09:00:00Z'),
        endsAt: new Date('2027-01-04T09:30:00Z'),
        status: 'scheduled',
      },
      {
        id: 'booking-2',
        patientId: 'patient-2',
        startsAt: new Date('2027-01-04T09:00:00Z'),
        endsAt: new Date('2027-01-04T09:30:00Z'),
        status: 'scheduled',
      },
    ]);

    await expect(new DoctorScheduleService().updateSchedule(doctorId, {
      timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17,
      slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 1,
      breakStart: null, breakEnd: null,
    })).rejects.toMatchObject({
      response: {
        conflicts: [expect.objectContaining({ id: 'booking-2', reason: expect.stringContaining('capacity') })],
      },
    });
    expect(upsert.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('detects conflict for an in-progress appointment when its interval is removed from the schedule', async () => {
    vi.useFakeTimers();
    // System time is 09:15 UTC; appointment started at 09:00 and ends at 09:30
    vi.setSystemTime(new Date('2027-01-04T09:15:00.000Z'));
    const inProgress = {
      id: 'in-progress-1',
      patientId: 'patient-1',
      startsAt: new Date('2027-01-04T09:00:00.000Z'),
      endsAt: new Date('2027-01-04T09:30:00.000Z'),
      status: 'scheduled',
    };
    const upsert = { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.insert).mockReturnValue(upsert as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    setScheduleReads([], [], [inProgress]);

    try {
      // Propose moving daily start hour from 9 to 10 (removing 09:00-10:00)
      await expect(new DoctorScheduleService().updateSchedule(doctorId, {
        timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 10, endHour: 17,
        slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 1,
        breakStart: null, breakEnd: null,
      })).rejects.toMatchObject({
        response: {
          conflicts: [expect.objectContaining({ id: 'in-progress-1' })],
        },
      });
      expect(upsert.onConflictDoUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not detect conflict for an in-progress appointment when its interval is retained in the schedule', async () => {
    vi.useFakeTimers();
    // System time is 09:15 UTC; appointment started at 09:00 and ends at 09:30
    vi.setSystemTime(new Date('2027-01-04T09:15:00.000Z'));
    const inProgress = {
      id: 'in-progress-2',
      patientId: 'patient-1',
      startsAt: new Date('2027-01-04T09:00:00.000Z'),
      endsAt: new Date('2027-01-04T09:30:00.000Z'),
      status: 'scheduled',
    };
    const upsert = { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.insert).mockReturnValue(upsert as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    setScheduleReads([], [], [inProgress]); // conflict check reads
    setScheduleReads([{
      timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], schedulingMode: 'wave', capacity: 1,
      startHour: 9, endHour: 17, slotDurationMinutes: 30, breakStart: null, breakEnd: null,
    }], [], []); // re-read saved schedule

    try {
      // Keep working hours 09:00-17:00 (interval is retained)
      await expect(new DoctorScheduleService().updateSchedule(doctorId, {
        timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17,
        slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 1,
        breakStart: null, breakEnd: null,
      })).resolves.toMatchObject({ startHour: 9, endHour: 17 });
      expect(upsert.onConflictDoUpdate).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks publication when unresolved affected appointments remain', async () => {
    const request = {
      id: 'req-pending-affected',
      doctorId,
      status: 'pending',
      approvedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      proposedSchedule: {
        timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17,
        slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 1, breakStart: null, breakEnd: null,
      },
    };
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor lock
      .mockImplementationOnce(() => query([request]) as never) // request lock
      .mockImplementationOnce(() => query([
        { resolutionStatus: 'pending', consentStatus: 'pending' },
      ]) as never); // affected appointment still pending

    const result = await new DoctorScheduleService().finalizeScheduleRequest(doctorId, request.id);
    expect(result).toMatchObject({ id: request.id, status: 'pending' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('creates a pending request with a 24-hour expiry and ranked alternatives without changing the schedule', async () => {
    vi.useFakeTimers();
    const createdAt = new Date('2027-01-01T10:00:00.000Z');
    vi.setSystemTime(createdAt);
    const request = {
      id: 'request-1',
      doctorId,
      proposedSchedule: {},
      status: 'pending',
      expiresAt: new Date('2027-01-02T10:00:00.000Z'),
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      expiredAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      createdAt,
      updatedAt: createdAt,
    };
    const affected = {
      id: 'affected-1',
      requestId: request.id,
      appointmentId: 'appointment-1',
      originalStartsAt: new Date('2027-01-04T11:00:00Z'),
      originalEndsAt: new Date('2027-01-04T11:30:00Z'),
      consentStatus: 'pending',
      resolutionStatus: 'pending',
      selectedAlternativeId: null,
      respondedAt: null,
      responseReason: null,
      resolvedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const insertRequest = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([request]),
    };
    const insertAffected = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([affected]),
    };
    const insertAlternatives = {
      values: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.insert)
      .mockReturnValueOnce(insertRequest as never)
      .mockReturnValueOnce(insertAffected as never)
      .mockReturnValueOnce(insertAlternatives as never);
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor row lock
      .mockImplementationOnce(() => query([]) as never) // duplicate request check
      .mockImplementationOnce(() => query([]) as never) // leaves
      .mockImplementationOnce(() => query([]) as never) // overrides
      .mockImplementationOnce(() => query([{
        id: 'appointment-1',
        startsAt: affected.originalStartsAt,
        endsAt: affected.originalEndsAt,
        status: 'pending_payment',
        holdExpiresAt: new Date('2027-01-04T10:30:00Z'),
      }]) as never) // conflicts
      .mockImplementationOnce(() => query([]) as never) // leaves for alternatives
      .mockImplementationOnce(() => query([]) as never) // overrides for alternatives
      .mockImplementationOnce(() => query([]) as never); // occupied alternatives

    const notificationsMock = {
      createNotification: vi.fn().mockResolvedValue({}),
    };
    try {
      const result = await new DoctorScheduleService(notificationsMock as never).createScheduleRequest(doctorId, {
        timezone: 'UTC',
        activeDays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 10,
        slotDurationMinutes: 30,
        schedulingMode: 'wave',
        capacity: 1,
        breakStart: null,
        breakEnd: null,
      });

      expect(notificationsMock.createNotification).not.toHaveBeenCalled();
      expect(insertRequest.values).toHaveBeenCalledWith(expect.objectContaining({
        doctorId,
        status: 'pending',
        expiresAt: new Date('2027-01-02T10:00:00.000Z'),
      }));
      expect(insertAffected.values).toHaveBeenCalledWith(expect.objectContaining({
        appointmentId: 'appointment-1',
        originalStartsAt: affected.originalStartsAt,
      }));
      expect(insertAlternatives.values).toHaveBeenCalled();
      expect(result.request.status).toBe('pending');
      expect(result.affectedAppointments[0]?.alternatives).toHaveLength(5);
      expect(result.affectedAppointments[0]?.alternatives[0]?.startsAt.toISOString())
        .toBe('2027-01-04T09:30:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes an approved request with no affected appointments exactly once', async () => {
    const request = {
      id: 'request-2',
      doctorId,
      status: 'pending',
      expiresAt: new Date('2027-01-02T10:00:00.000Z'),
      approvedAt: null,
      proposedSchedule: {
        timezone: 'UTC',
        activeDays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 17,
        slotDurationMinutes: 30,
        schedulingMode: 'wave',
        capacity: 1,
        breakStart: null,
        breakEnd: null,
      },
    };
    const updateBuilder = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn()
        .mockResolvedValueOnce([{ ...request, approvedAt: new Date(), approvedBy: doctorId }])
        .mockResolvedValueOnce([{ ...request, status: 'published', approvedAt: new Date(), publishedAt: new Date() }]),
    };
    vi.mocked(db.update).mockReturnValue(updateBuilder as never);
    const insertAvailability = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{
        id: 'availability-1',
        doctorId,
        timezone: 'UTC',
      }]),
    };
    vi.mocked(db.insert).mockReturnValue(insertAvailability as never);
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor row lock
      .mockImplementationOnce(() => query([request]) as never) // request lock
      .mockImplementationOnce(() => query([]) as never) // no affected appointments
      .mockImplementationOnce(() => query([]) as never) // doctor row lock during finalization
      .mockImplementationOnce(() => query([{ ...request, approvedAt: new Date() }]) as never) // request lock during finalization
      .mockImplementationOnce(() => query([]) as never) // no affected appointments during finalization
      .mockImplementationOnce(() => query([]) as never) // leaves during finalization conflict check
      .mockImplementationOnce(() => query([]) as never) // overrides during finalization conflict check
      .mockImplementationOnce(() => query([]) as never); // appointments during finalization conflict check

    const approved = await new DoctorScheduleService().approveScheduleRequest(doctorId, request.id);

    expect(updateBuilder.set).toHaveBeenCalledWith(expect.objectContaining({
      approvedBy: doctorId,
    }));
    expect(approved.status).toBe('published');
    expect(approved.publishedAt).toBeDefined();
    expect(insertAvailability.onConflictDoUpdate).toHaveBeenCalled();

    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never)
      .mockImplementationOnce(() => query([{ ...request, status: 'published' }]) as never);
    await expect(new DoctorScheduleService().finalizeScheduleRequest(doctorId, request.id))
      .resolves.toMatchObject({ status: 'published' });
    expect(updateBuilder.returning).toHaveBeenCalledTimes(2);
  });

  it('notifies affected patients upon approval when unresolved affected appointments exist', async () => {
    const request = {
      id: 'request-with-affected',
      doctorId,
      status: 'pending',
      expiresAt: new Date(Date.now() + 86400000),
      approvedAt: null,
      proposedSchedule: {
        timezone: 'UTC',
        activeDays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 17,
        slotDurationMinutes: 30,
        schedulingMode: 'wave',
        capacity: 1,
        breakStart: null,
        breakEnd: null,
      },
    };
    const updateBuilder = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValueOnce([{ ...request, approvedAt: new Date(), approvedBy: doctorId }]),
    };
    vi.mocked(db.update).mockReturnValue(updateBuilder as never);
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor row lock
      .mockImplementationOnce(() => query([request]) as never) // request lock
      .mockImplementationOnce(() => query([{ id: 'aff-1', consentStatus: 'pending', resolutionStatus: 'pending' }]) as never) // affected
      .mockImplementationOnce(() => query([{ affectedAppointmentId: 'aff-1' }]) as never) // alternatives
      .mockImplementationOnce(() => query([{ patientId: 'patient-42', appointmentId: 'appt-1' }]) as never) // notification recipients
      .mockImplementationOnce(() => query([]) as never) // doctor row lock during finalization
      .mockImplementationOnce(() => query([{ ...request, approvedAt: new Date() }]) as never) // request lock during finalization
      .mockImplementationOnce(() => query([{ consentStatus: 'pending', resolutionStatus: 'pending' }]) as never); // affected during finalization

    const notificationsMock = {
      createNotification: vi.fn().mockResolvedValue({}),
    };
    const service = new DoctorScheduleService(notificationsMock as never);
    const approved = await service.approveScheduleRequest(doctorId, request.id);

    expect(approved.approvedAt).toBeDefined();
    expect(notificationsMock.createNotification).toHaveBeenCalledTimes(1);
    expect(notificationsMock.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'patient-42',
      title: 'Schedule change requires your response',
      message: 'Your doctor approved a schedule change proposal. Please review your alternative appointment times.',
      type: 'reschedule',
      appointmentId: 'appt-1',
      scheduleRequestId: request.id,
    }));
  });

  it('does not duplicate notifications upon repeated approval of an already approved request', async () => {
    const alreadyApprovedRequest = {
      id: 'request-already-approved',
      doctorId,
      status: 'pending',
      expiresAt: new Date(Date.now() + 86400000),
      approvedAt: new Date('2027-01-01T10:00:00.000Z'),
      proposedSchedule: {
        timezone: 'UTC',
        activeDays: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 17,
        slotDurationMinutes: 30,
        schedulingMode: 'wave',
        capacity: 1,
        breakStart: null,
        breakEnd: null,
      },
    };
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor row lock
      .mockImplementationOnce(() => query([alreadyApprovedRequest]) as never) // request lock
      .mockImplementationOnce(() => query([]) as never) // doctor row lock during finalization
      .mockImplementationOnce(() => query([alreadyApprovedRequest]) as never) // request lock during finalization
      .mockImplementationOnce(() => query([{ consentStatus: 'pending', resolutionStatus: 'pending' }]) as never); // affected during finalization

    const notificationsMock = {
      createNotification: vi.fn().mockResolvedValue({}),
    };
    const service = new DoctorScheduleService(notificationsMock as never);
    const result = await service.approveScheduleRequest(doctorId, alreadyApprovedRequest.id);

    expect(result.id).toBe(alreadyApprovedRequest.id);
    expect(notificationsMock.createNotification).not.toHaveBeenCalled();
  });

  it('rejects a request only for its owning doctor and is idempotent after cancellation', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // first doctor row lock
      .mockImplementationOnce(() => query([]) as never) // missing request
      .mockImplementationOnce(() => query([]) as never) // second doctor row lock
      .mockImplementationOnce(() => query([{ id: 'request-3', status: 'cancelled' }]) as never);

    await expect(new DoctorScheduleService().rejectScheduleRequest('another-doctor', 'request-3', 'No longer needed'))
      .rejects.toThrow('Schedule change request not found.');
    await expect(new DoctorScheduleService().rejectScheduleRequest(doctorId, 'request-3', 'No longer needed'))
      .resolves.toMatchObject({ status: 'cancelled' });
  });

  it('blocks publication after a decline when the original appointment conflicts with the proposed schedule', async () => {
    const request = {
      id: 'request-blocked', doctorId, status: 'pending', approvedAt: new Date('2027-01-01T10:00:00Z'),
      expiresAt: new Date('2027-01-02T10:00:00Z'),
      proposedSchedule: {
        timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 10,
        slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 1, breakStart: null, breakEnd: null,
      },
    };
    const original = {
      id: 'appointment-declined', patientId: 'patient-1', startsAt: new Date('2027-01-04T10:00:00Z'),
      endsAt: new Date('2027-01-04T10:30:00Z'), status: 'scheduled',
    };
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor lock
      .mockImplementationOnce(() => query([request]) as never) // request lock
      .mockImplementationOnce(() => query([{ resolutionStatus: 'cancelled' }]) as never) // patient declined
      .mockImplementationOnce(() => query([]) as never) // leaves
      .mockImplementationOnce(() => query([]) as never) // overrides
      .mockImplementationOnce(() => query([original]) as never); // original appointment remains booked

    const result = await new DoctorScheduleService().finalizeScheduleRequest(doctorId, request.id);

    expect(result).toMatchObject({ status: 'pending', publicationBlocked: true });
    expect((result as { publicationBlockers?: Array<{ id: string }> }).publicationBlockers)
      .toEqual([expect.objectContaining({ id: original.id })]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('prevents rejection after approval or an appointment resolution has begun', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor lock
      .mockImplementationOnce(() => query([{
        id: 'approved-request', status: 'pending', approvedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      }]) as never);
    await expect(new DoctorScheduleService().rejectScheduleRequest(doctorId, 'approved-request', 'Changed my mind'))
      .rejects.toThrow('Cannot reject a pending schedule change request.');

    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // doctor lock
      .mockImplementationOnce(() => query([{
        id: 'resolved-request', status: 'pending', approvedAt: null, expiresAt: new Date(Date.now() + 60_000),
      }]) as never)
      .mockImplementationOnce(() => query([{ consentStatus: 'declined', resolutionStatus: 'cancelled' }]) as never);
    await expect(new DoctorScheduleService().rejectScheduleRequest(doctorId, 'resolved-request', 'Changed my mind'))
      .rejects.toThrow('Cannot reject a request after an appointment resolution has begun.');
  });

  it('allows explicit cancellation to resolve a zero-alternative appointment before approval', async () => {
    const request = {
      id: 'request-zero-alternatives', doctorId, status: 'pending', approvedAt: null,
      expiresAt: new Date('2027-01-02T10:00:00Z'),
      proposedSchedule: {
        timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17,
        slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 1, breakStart: null, breakEnd: null,
      },
    };
    const updateBuilder = {
      set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
      returning: vi.fn()
        .mockResolvedValueOnce([{ ...request, approvedAt: new Date(), approvedBy: doctorId }])
        .mockResolvedValueOnce([{ ...request, status: 'published', approvedAt: new Date(), publishedAt: new Date() }]),
    };
    const availabilityInsert = {
      values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 'availability-zero-alternatives', doctorId }]),
    };
    vi.mocked(db.update).mockReturnValue(updateBuilder as never);
    vi.mocked(db.insert).mockReturnValue(availabilityInsert as never);
    vi.mocked(db.select)
      .mockImplementationOnce(() => query([]) as never) // approval doctor lock
      .mockImplementationOnce(() => query([request]) as never) // approval request lock
      .mockImplementationOnce(() => query([{
        id: 'affected-zero-alternatives', consentStatus: 'declined', resolutionStatus: 'cancelled',
      }]) as never) // explicit cancellation has resolved it
      .mockImplementationOnce(() => query([]) as never) // finalization doctor lock
      .mockImplementationOnce(() => query([{ ...request, approvedAt: new Date() }]) as never) // finalization request lock
      .mockImplementationOnce(() => query([{ resolutionStatus: 'cancelled' }]) as never)
      .mockImplementationOnce(() => query([]) as never) // leaves
      .mockImplementationOnce(() => query([]) as never) // overrides
      .mockImplementationOnce(() => query([]) as never); // no remaining booked conflicts

    await expect(new DoctorScheduleService().approveScheduleRequest(doctorId, request.id))
      .resolves.toMatchObject({ status: 'published' });
    expect(availabilityInsert.onConflictDoUpdate).toHaveBeenCalled();
  });

  it('upserts a leave by doctor and date and deletes it only for that doctor', async () => {
    const leave = {
      id: 'leave-1', doctorId, date: '2027-02-15', reason: 'Conference',
      createdAt: new Date('2026-11-05T00:00:00Z'),
    };
    const insertBuilder = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([leave]),
    };
    vi.mocked(db.insert).mockReturnValue(insertBuilder as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    const saved = await new DoctorScheduleService().addLeave(doctorId, { date: leave.date, reason: leave.reason });
    expect(insertBuilder.onConflictDoUpdate).toHaveBeenCalled();
    expect(saved).toMatchObject({ id: leave.id, date: leave.date, reason: leave.reason });

    const deleteBuilder = { where: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValue([{ id: leave.id }]) };
    vi.mocked(db.delete).mockReturnValue(deleteBuilder as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    await expect(new DoctorScheduleService().removeLeave(doctorId, leave.id)).resolves.toBeUndefined();
    expect(deleteBuilder.where).toHaveBeenCalled();
  });

  it('persists date-specific overrides and supports removing them', async () => {
    const savedOverride = {
      id: 'override-1', doctorId, date: '2027-02-15', startHour: 11, endHour: 16,
      slotDurationMinutes: 15, breakStart: null, breakEnd: null,
      schedulingMode: 'wave', capacity: 3,
      createdAt: new Date('2026-11-05T00:00:00Z'), updatedAt: new Date('2026-11-05T00:00:00Z'),
    };
    const insertBuilder = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([savedOverride]),
    };
    vi.mocked(db.insert).mockReturnValue(insertBuilder as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    const saved = await new DoctorScheduleService().upsertOverride(doctorId, {
      date: savedOverride.date, startHour: 11, endHour: 16, slotDurationMinutes: 15,
      schedulingMode: 'wave', capacity: 3,
    });
    expect(insertBuilder.onConflictDoUpdate).toHaveBeenCalled();
    expect(saved).toMatchObject({ date: savedOverride.date, startHour: 11, endHour: 16, slotDurationMinutes: 15 });

    const deleteBuilder = { where: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValue([{ id: savedOverride.id }]) };
    vi.mocked(db.delete).mockReturnValue(deleteBuilder as never);
    vi.mocked(db.select).mockImplementationOnce(() => query([]) as never); // doctor row lock
    await expect(new DoctorScheduleService().removeOverride(doctorId, savedOverride.date)).resolves.toBeUndefined();
  });

  it('loads saved weekly data, leaves, and overrides together for booking calculations', async () => {
    const saved = { timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, slotDurationMinutes: 30, schedulingMode: 'wave', capacity: 5, breakStart: null, breakEnd: null };
    const leave = { id: 'leave-1', date: '2027-02-15', reason: null, createdAt: new Date('2026-11-05T00:00:00Z') };
    const override = {
      id: 'override-1', date: '2027-02-16', startHour: 11, endHour: 16, slotDurationMinutes: 15,
      breakStart: null, breakEnd: null, createdAt: new Date('2026-11-05T00:00:00Z'), updatedAt: new Date('2026-11-05T00:00:00Z'),
      schedulingMode: 'stream', capacity: 2,
    };
    vi.mocked(db.select).mockImplementationOnce(() => query([{ userId: doctorId }]) as never);
    setScheduleReads([saved], [leave], [override]);
    const config = await new DoctorScheduleService().getScheduleConfigForProfile('profile-1');
    expect(config.leaveDates).toEqual(['2027-02-15']);
    expect(config.dateOverrides).toMatchObject([{ date: '2027-02-16', startHour: 11, slotDurationMinutes: 15 }]);
    expect(config.capacity).toBe(5);
    expect(config.schedulingMode).toBe('wave');
    expect(config.dateOverrides).toMatchObject([{ schedulingMode: 'stream', capacity: 2 }]);
  });
});
