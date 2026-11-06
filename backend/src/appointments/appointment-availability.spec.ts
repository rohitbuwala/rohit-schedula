import { candidateSlotsForDate, createZonedDate, getAvailableSlots, getAvailableSlotsWithCapacity, getDurationForDate, isBookableSlot } from './appointment-availability.js';

describe('appointment availability', () => {
  const now = new Date('2027-01-01T00:00:00.000Z');

  it('returns only future weekday slots during UTC clinic hours', () => {
    const slots = candidateSlotsForDate('2027-01-04', now);
    expect(slots).toHaveLength(16);
    expect(slots[0]?.startsAt.toISOString()).toBe('2027-01-04T09:00:00.000Z');
    expect(slots.at(-1)?.endsAt.toISOString()).toBe('2027-01-04T17:00:00.000Z');
    expect(candidateSlotsForDate('2027-01-02', now)).toHaveLength(0);
    expect(candidateSlotsForDate('2027-01-04', new Date('2027-01-04T09:15:00.000Z'))[0]?.startsAt.toISOString()).toBe('2027-01-04T09:30:00.000Z');
  });

  it('removes overlapping scheduled slots but ignores cancelled and completed appointments', () => {
    const slots = getAvailableSlots('2027-01-04', [
      { startsAt: new Date('2027-01-04T09:15:00Z'), endsAt: new Date('2027-01-04T09:45:00Z'), status: 'scheduled' },
      { startsAt: new Date('2027-01-04T10:00:00Z'), endsAt: new Date('2027-01-04T10:30:00Z'), status: 'cancelled' },
      { startsAt: new Date('2027-01-04T10:30:00Z'), endsAt: new Date('2027-01-04T11:00:00Z'), status: 'completed' },
    ], now, { schedulingMode: 'wave' });
    expect(slots).toHaveLength(14);
    expect(slots.some(({ startsAt }) => startsAt.toISOString() === '2027-01-04T09:00:00.000Z')).toBe(false);
    expect(slots.some(({ startsAt }) => startsAt.toISOString() === '2027-01-04T09:30:00.000Z')).toBe(false);
    expect(slots.some(({ startsAt }) => startsAt.toISOString() === '2027-01-04T10:00:00.000Z')).toBe(true);
  });

  it('reports per-slot remaining capacity including active payment holds', () => {
    const options = getAvailableSlotsWithCapacity('2027-01-04', [
      { startsAt: new Date('2027-01-04T09:00:00Z'), endsAt: new Date('2027-01-04T09:30:00Z'), status: 'scheduled' },
      { startsAt: new Date('2027-01-04T09:00:00Z'), endsAt: new Date('2027-01-04T09:30:00Z'), status: 'pending_payment', holdExpiresAt: new Date('2027-01-01T01:00:00Z') },
      { startsAt: new Date('2027-01-04T09:00:00Z'), endsAt: new Date('2027-01-04T09:30:00Z'), status: 'pending_payment', holdExpiresAt: new Date('2026-12-31T23:00:00Z') },
    ], now, { capacity: 3, schedulingMode: 'wave' });
    expect(options[0]).toMatchObject({ mode: 'wave', capacity: 3, remainingCapacity: 1 });
    expect(options[0]?.slotId).toBeTruthy();
    expect(options[0]?.sessionId).toBe(options[0]?.slotId);
  });

  it('generates Stream slots in fixed 15-minute intervals without using appointment duration', () => {
    const options = getAvailableSlotsWithCapacity('2027-01-04', [], now, {
      timezone: 'UTC',
      activeDays: [1, 2, 3, 4, 5],
      startHour: 9,
      endHour: 10,
      slotDurationMinutes: 30,
      schedulingMode: 'stream',
      capacity: 2,
    });

    expect(options).toHaveLength(4);
    expect(options.map(({ startsAt, endsAt }) => [startsAt.toISOString(), endsAt.toISOString()])).toEqual([
      ['2027-01-04T09:00:00.000Z', '2027-01-04T09:15:00.000Z'],
      ['2027-01-04T09:15:00.000Z', '2027-01-04T09:30:00.000Z'],
      ['2027-01-04T09:30:00.000Z', '2027-01-04T09:45:00.000Z'],
      ['2027-01-04T09:45:00.000Z', '2027-01-04T10:00:00.000Z'],
    ]);
    expect(getDurationForDate('2027-01-04', {
      slotDurationMinutes: 30,
      schedulingMode: 'stream',
    })).toBe(15);
  });

  it('generates recurring Wave sessions with capacity remaining per weekly slot', () => {
    const options = getAvailableSlotsWithCapacity('2027-01-04', [
      { startsAt: new Date('2027-01-04T09:00:00Z'), endsAt: new Date('2027-01-04T09:30:00Z'), status: 'scheduled' },
    ], now, {
      activeDays: [1, 2, 3, 4, 5],
      startHour: 9,
      endHour: 10,
      slotDurationMinutes: 30,
      schedulingMode: 'wave',
      capacity: 3,
    });

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ mode: 'wave', capacity: 3, remainingCapacity: 2 });
    expect(options[0]?.sessionId).toBe(options[0]?.slotId);
    expect(options[1]).toMatchObject({ mode: 'wave', capacity: 3, remainingCapacity: 3 });
  });

  it('generates a non-recurring Wave session from a date override on an inactive weekday', () => {
    const options = getAvailableSlotsWithCapacity('2027-01-03', [
      { startsAt: new Date('2027-01-03T11:00:00Z'), endsAt: new Date('2027-01-03T11:30:00Z'), status: 'pending_payment', holdExpiresAt: new Date('2027-01-01T01:00:00Z') },
    ], now, {
      timezone: 'UTC',
      activeDays: [1, 2, 3, 4, 5],
      startHour: 9,
      endHour: 17,
      slotDurationMinutes: 30,
      schedulingMode: 'stream',
      capacity: 1,
      dateOverrides: [{
        date: '2027-01-03', startHour: 11, endHour: 12, slotDurationMinutes: 30,
        breakStart: null, breakEnd: null, schedulingMode: 'wave', capacity: 2,
      }],
    });

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ mode: 'wave', capacity: 2, remainingCapacity: 1 });
    expect(options[0]?.sessionId).toBe(options[0]?.slotId);
  });

  it('applies date override mode and capacity while retaining default capacity one', () => {
    const options = getAvailableSlotsWithCapacity('2027-01-04', [], now, {
      capacity: 4,
      schedulingMode: 'wave',
      dateOverrides: [{
        date: '2027-01-04', startHour: 9, endHour: 10, slotDurationMinutes: 30,
        breakStart: null, breakEnd: null, schedulingMode: 'stream', capacity: 2,
      }],
    });
    expect(options).toHaveLength(4);
    expect(options[0]).toMatchObject({
      startsAt: new Date('2027-01-04T09:00:00.000Z'),
      endsAt: new Date('2027-01-04T09:15:00.000Z'),
    });
    expect(options[0]).toMatchObject({ mode: 'stream', capacity: 2, remainingCapacity: 2, sessionId: null });
    const defaults = getAvailableSlotsWithCapacity('2027-01-04', [], now);
    expect(defaults[0]).toMatchObject({ mode: 'stream', capacity: 1, remainingCapacity: 1 });
  });

  it('uses the date override duration for availability metadata', () => {
    expect(getDurationForDate('2027-01-04', {
      slotDurationMinutes: 30,
      dateOverrides: [{
        date: '2027-01-04', startHour: 9, endHour: 10, slotDurationMinutes: 15,
        breakStart: null, breakEnd: null, schedulingMode: 'wave',
      }],
    })).toBe(15);
    expect(getDurationForDate('2027-01-04', {
      slotDurationMinutes: 30,
      dateOverrides: [{
        date: '2027-01-04', startHour: 9, endHour: 10, slotDurationMinutes: 30,
        breakStart: null, breakEnd: null, schedulingMode: 'stream',
      }],
    })).toBe(15);
    expect(getDurationForDate('2027-01-05', { slotDurationMinutes: 15 })).toBe(15);
  });

  it('accepts only exact offered slot boundaries', () => {
    expect(isBookableSlot(new Date('2027-01-04T09:00:00Z'), new Date('2027-01-04T09:30:00Z'), now, { schedulingMode: 'wave' })).toBe(true);
    expect(isBookableSlot(new Date('2027-01-04T09:15:00Z'), new Date('2027-01-04T09:45:00Z'), now)).toBe(false);
  });

  it('respects custom start and end hours', () => {
    const slots = candidateSlotsForDate('2027-01-04', now, { startHour: 10, endHour: 14, schedulingMode: 'wave' });
    expect(slots).toHaveLength(8);
    expect(slots[0]?.startsAt.toISOString()).toBe('2027-01-04T10:00:00.000Z');
    expect(slots.at(-1)?.endsAt.toISOString()).toBe('2027-01-04T14:00:00.000Z');
  });

  it('excludes slots falling within configured break hours', () => {
    const slots = candidateSlotsForDate('2027-01-04', now, {
      startHour: 9,
      endHour: 13,
      schedulingMode: 'wave',
      breakStart: '11:00',
      breakEnd: '12:00',
    });
    // Hours: 9-10 (2), 10-11 (2), 11-12 (break skipped), 12-13 (2) => total 6 slots
    expect(slots).toHaveLength(6);
    expect(slots.some((s) => s.startsAt.toISOString() === '2027-01-04T11:00:00.000Z')).toBe(false);
    expect(slots.some((s) => s.startsAt.toISOString() === '2027-01-04T11:30:00.000Z')).toBe(false);
  });

  it('returns 0 slots for leave dates', () => {
    const slots = candidateSlotsForDate('2027-01-04', now, {
      leaveDates: ['2027-01-04'],
    });
    expect(slots).toHaveLength(0);
  });

  it('respects custom active days (e.g. enabling Saturday)', () => {
    // 2027-01-02 is Saturday (dayOfWeek=6)
    const defaultSlots = candidateSlotsForDate('2027-01-02', now);
    expect(defaultSlots).toHaveLength(0);

    const saturdaySlots = candidateSlotsForDate('2027-01-02', now, {
      activeDays: [1, 2, 3, 4, 5, 6],
    });
    expect(saturdaySlots.length).toBeGreaterThan(0);
  });

  it('generates slots in Asia/Kolkata (IST) timezone correctly', () => {
    // 2027-01-04 is Monday
    const slots = candidateSlotsForDate('2027-01-04', now, { timezone: 'Asia/Kolkata', schedulingMode: 'wave' });
    expect(slots).toHaveLength(16);
    // 09:00 IST is 03:30 UTC
    expect(slots[0]?.startsAt.toISOString()).toBe('2027-01-04T03:30:00.000Z');
    expect(slots[0]?.endsAt.toISOString()).toBe('2027-01-04T04:00:00.000Z');
    // 17:00 IST is 11:30 UTC
    expect(slots.at(-1)?.endsAt.toISOString()).toBe('2027-01-04T11:30:00.000Z');
  });

  it('generates 15-minute slot intervals when configured', () => {
    const slots = candidateSlotsForDate('2027-01-04', now, {
      timezone: 'Asia/Kolkata',
      slotDurationMinutes: 15,
    });
    // 8 hours * 4 slots/hour = 32 slots
    expect(slots).toHaveLength(32);
    expect(slots[0]?.startsAt.toISOString()).toBe('2027-01-04T03:30:00.000Z');
    expect(slots[0]?.endsAt.toISOString()).toBe('2027-01-04T03:45:00.000Z');
  });

  it('uses a persisted date override in place of weekly hours and duration, including inactive weekdays', () => {
    const slots = candidateSlotsForDate('2027-01-03', now, {
      timezone: 'Asia/Kolkata',
      activeDays: [1, 2, 3, 4, 5],
      startHour: 9,
      endHour: 17,
      slotDurationMinutes: 30,
      dateOverrides: [{
        date: '2027-01-03', startHour: 11, endHour: 12, slotDurationMinutes: 15,
        breakStart: null, breakEnd: null,
      }],
    });
    expect(slots).toHaveLength(4);
    expect(slots[0]?.startsAt.toISOString()).toBe('2027-01-03T05:30:00.000Z');
    expect(slots.at(-1)?.endsAt.toISOString()).toBe('2027-01-03T06:30:00.000Z');
  });

  it('converts local schedule dates using the timezone offset in effect on that date', () => {
    const winter = createZonedDate('2027-01-04', 9, 0, 'America/New_York');
    const summer = createZonedDate('2027-07-05', 9, 0, 'America/New_York');
    expect(winter.toISOString()).toBe('2027-01-04T14:00:00.000Z');
    expect(summer.toISOString()).toBe('2027-07-05T13:00:00.000Z');
  });

  it('rejects nonexistent spring-forward local times and skips those generated slots', () => {
    const nonexistent = createZonedDate('2027-03-14', 2, 30, 'America/New_York');
    expect(Number.isNaN(nonexistent.getTime())).toBe(true);

    const slots = candidateSlotsForDate('2027-03-14', now, {
      timezone: 'America/New_York',
      activeDays: [0],
      startHour: 1,
      endHour: 4,
      slotDurationMinutes: 30,
      schedulingMode: 'wave',
    });
    expect(slots.map(({ startsAt }) => startsAt.toISOString())).toEqual([
      '2027-03-14T06:00:00.000Z',
      '2027-03-14T06:30:00.000Z',
      '2027-03-14T07:00:00.000Z',
      '2027-03-14T07:30:00.000Z',
    ]);
  });

  it('resolves ambiguous fall-back local times to the earlier UTC instant', () => {
    const ambiguous = createZonedDate('2027-11-07', 1, 30, 'America/New_York');
    expect(ambiguous.toISOString()).toBe('2027-11-07T05:30:00.000Z');
  });

  it('filters out past slots in Asia/Kolkata', () => {
    // 10:15 IST is 04:45 UTC
    const currentIst = new Date('2027-01-04T04:45:00.000Z');
    const slots = candidateSlotsForDate('2027-01-04', currentIst, { timezone: 'Asia/Kolkata' });
    // First slot should be after 10:15 IST -> 10:30 IST (05:00 UTC)
    expect(slots[0]?.startsAt.toISOString()).toBe('2027-01-04T05:00:00.000Z');
  });

  it('accepts 15-minute and 30-minute bookable slots in IST', () => {
    // 09:00-09:15 IST = 03:30-03:45 UTC
    const start15 = new Date('2027-01-04T03:30:00.000Z');
    const end15 = new Date('2027-01-04T03:45:00.000Z');
    expect(isBookableSlot(start15, end15, now, { schedulingMode: 'stream' })).toBe(true);

    // 09:00-09:30 IST = 03:30-04:00 UTC
    const start30 = new Date('2027-01-04T03:30:00.000Z');
    const end30 = new Date('2027-01-04T04:00:00.000Z');
    expect(isBookableSlot(start30, end30, now, { schedulingMode: 'wave' })).toBe(true);

    // Past slot should be rejected
    expect(isBookableSlot(start30, end30, new Date('2027-01-04T04:30:00.000Z'))).toBe(false);

    // Invalid duration (e.g. 10 minutes) should be rejected
    const end10 = new Date('2027-01-04T03:40:00.000Z');
    expect(isBookableSlot(start15, end10, now)).toBe(false);
  });
});
