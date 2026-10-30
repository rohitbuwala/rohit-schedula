import { DoctorScheduleService } from './doctor-schedule.service.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

describe('doctor schedule service', () => {
  const doctorId = 'doctor-123';

  it('returns default schedule when doctor has no custom schedule', async () => {
    const service = new DoctorScheduleService();
    const schedule = await service.getSchedule(doctorId);
    expect(schedule.timezone).toBe('UTC');
    expect(schedule.activeDays).toEqual([1, 2, 3, 4, 5]);
    expect(schedule.startHour).toBe(9);
    expect(schedule.endHour).toBe(17);
    expect(schedule.leaves).toHaveLength(0);
  });

  it('updates schedule and persists changes in memory', async () => {
    const service = new DoctorScheduleService();
    const updated = await service.updateSchedule(doctorId, {
      timezone: 'America/New_York',
      activeDays: [1, 2, 3, 4, 5, 6],
      startHour: 10,
      endHour: 18,
      slotDurationMinutes: 30,
      breakStart: '13:00',
      breakEnd: '14:00',
    });
    expect(updated.timezone).toBe('America/New_York');
    expect(updated.activeDays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(updated.startHour).toBe(10);
    expect(updated.breakStart).toBe('13:00');

    const fetched = await service.getSchedule(doctorId);
    expect(fetched.timezone).toBe('America/New_York');
  });

  it('adds and removes leave dates', async () => {
    const service = new DoctorScheduleService();
    const leave = await service.addLeave(doctorId, {
      date: '2027-02-15',
      reason: 'Medical Conference',
    });
    expect(leave.date).toBe('2027-02-15');

    const schedule = await service.getSchedule(doctorId);
    expect(schedule.leaves).toHaveLength(1);

    await service.removeLeave(doctorId, leave.id);
    const scheduleAfter = await service.getSchedule(doctorId);
    expect(scheduleAfter.leaves).toHaveLength(0);
  });
});
