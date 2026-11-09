import { DoctorScheduleService } from './doctor-schedule.service.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

function query(result: unknown) {
  const builder: any = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    for: vi.fn(() => builder),
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
    vi.mocked(db.transaction).mockImplementation(((callback: (tx: unknown) => unknown) =>
      Promise.resolve(callback({ select: db.select, insert: db.insert, delete: db.delete }))) as never);
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
