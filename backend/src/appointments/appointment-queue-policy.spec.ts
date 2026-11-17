import { ConflictException } from '@nestjs/common';
import { assertCheckInEligible, decodeQueueCursor, queueDayBounds, queueLocalDate } from './appointment-queue-policy.js';
import { ownQueueReadSchema, queueReadSchema } from './appointment-queue.schema.js';

describe('queue calendar and eligibility policy', () => {
  it('uses the doctor’s local date instead of a UTC date slice', () => {
    const now = new Date('2026-11-15T20:00:00Z');
    expect(queueLocalDate(now, 'Asia/Kolkata')).toBe('2026-11-16');
    expect(() => assertCheckInEligible({ status: 'scheduled', startsAt: new Date('2026-11-16T04:30:00Z') }, 'Asia/Kolkata', now)).not.toThrow();
    expect(() => assertCheckInEligible({ status: 'scheduled', startsAt: new Date('2026-11-17T04:30:00Z') }, 'Asia/Kolkata', now)).toThrow(ConflictException);
  });

  it.each(['pending_payment', 'cancelled', 'completed'])('rejects %s bookings', status => {
    const now = new Date();
    expect(() => assertCheckInEligible({ status, startsAt: now }, 'UTC', now)).toThrow(ConflictException);
  });

  it('supports 23-hour, 25-hour and midnight-gap service dates', () => {
    const spring = queueDayBounds('2026-03-08', 'America/New_York');
    const fall = queueDayBounds('2026-11-01', 'America/New_York');
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3600000);
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3600000);
    const gap = queueDayBounds('2018-11-04', 'America/Sao_Paulo');
    expect(queueLocalDate(gap.start, 'America/Sao_Paulo')).toBe('2018-11-04');
    expect(gap.end.getTime() - gap.start.getTime()).toBe(23 * 3600000);
    expect(() => queueDayBounds('2026-11-16', 'not-a-timezone')).toThrow(ConflictException);
    // A skipped date must not invalidate the preceding actual service day.
    expect(queueDayBounds('2011-12-29', 'Pacific/Apia').start).toBeInstanceOf(Date);
    expect(() => queueDayBounds('2011-12-30', 'Pacific/Apia')).toThrow(ConflictException);
  });

  it('rejects invalid dates, unbounded pages, forged fields and malformed cursors', () => {
    const input = { doctorId: 'opaque-doctor', date: '2026-11-16' };
    expect(queueReadSchema.parse(input).limit).toBe(50);
    for (const extra of [{ date: '2026-02-30' }, { limit: 101 }, { cursor: '-1:0' }, { cursor: '2147483648:0' }, { cursor: '1:100001' }, { patientId: 'other' }]) {
      expect(queueReadSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(decodeQueueCursor('8:50')).toEqual({ version: 8, offset: 50 });
    expect(decodeQueueCursor()).toBeNull();
  });

  it('bounds and deduplicates patient batch identifiers', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(ownQueueReadSchema.parse({ appointmentIds: id }).appointmentIds).toEqual([id]);
    for (const appointmentIds of ['', 'not-a-uuid', `${id},${id}`, Array(51).fill(id).join(',')]) {
      expect(ownQueueReadSchema.safeParse({ appointmentIds }).success).toBe(false);
    }
  });
});
