import { candidateSlotsForDate, getAvailableSlots, isBookableSlot } from './appointment-availability.js';

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
    ], now);
    expect(slots).toHaveLength(14);
    expect(slots.some(({ startsAt }) => startsAt.toISOString() === '2027-01-04T09:00:00.000Z')).toBe(false);
    expect(slots.some(({ startsAt }) => startsAt.toISOString() === '2027-01-04T09:30:00.000Z')).toBe(false);
    expect(slots.some(({ startsAt }) => startsAt.toISOString() === '2027-01-04T10:00:00.000Z')).toBe(true);
  });

  it('accepts only exact offered slot boundaries', () => {
    expect(isBookableSlot(new Date('2027-01-04T09:00:00Z'), new Date('2027-01-04T09:30:00Z'), now)).toBe(true);
    expect(isBookableSlot(new Date('2027-01-04T09:15:00Z'), new Date('2027-01-04T09:45:00Z'), now)).toBe(false);
  });
});
