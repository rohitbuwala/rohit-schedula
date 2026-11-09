import { doctorScheduleUpdateSchema } from './doctor-schedule.schema.js';

describe('doctor schedule timezone validation', () => {
  const validSchedule = {
    activeDays: [1],
    startHour: 9,
    endHour: 17,
  };

  it('accepts supported IANA timezones and trims surrounding whitespace', () => {
    const parsed = doctorScheduleUpdateSchema.parse({ ...validSchedule, timezone: ' America/New_York ' });
    expect(parsed.timezone).toBe('America/New_York');
  });

  it('rejects unknown timezone identifiers before they can be persisted', () => {
    expect(doctorScheduleUpdateSchema.safeParse({ ...validSchedule, timezone: 'Mars/Olympus_Mons' }).success).toBe(false);
  });

  it('requires duration for Wave but accepts Stream without duration', () => {
    expect(doctorScheduleUpdateSchema.safeParse({
      ...validSchedule,
      schedulingMode: 'wave',
    }).success).toBe(false);
    expect(doctorScheduleUpdateSchema.safeParse({
      ...validSchedule,
      schedulingMode: 'stream',
    }).success).toBe(true);
  });
});
