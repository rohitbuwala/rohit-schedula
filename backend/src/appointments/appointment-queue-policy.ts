import { ConflictException } from '@nestjs/common';
import { createZonedDate } from './appointment-availability.js';

export function queueLocalDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = (name: string) => parts.find(item => item.type === name)!.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

export function queueDayBounds(date: string, timezone: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new ConflictException({ code: 'QUEUE_TIMEZONE_INVALID', message: 'The queue timezone is invalid.' }); }
  // Calendar arithmetic is performed on the date, not by adding 24h to an instant.
  const tomorrow = new Date(`${date}T12:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  function firstInstant(localDate: string) {
    const midnight = createZonedDate(localDate, 0, 0, timezone);
    if (Number.isFinite(midnight.getTime())) return midnight;
    // Some timezones move clocks at midnight. Find the first actual instant of
    // that date instead of treating a midnight gap as a missing service day.
    const noon = Date.parse(`${localDate}T12:00:00Z`);
    let low = noon - 48 * 3600000, high = noon + 48 * 3600000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (queueLocalDate(new Date(middle), timezone) < localDate) low = middle + 1;
      else high = middle;
    }
    return new Date(low);
  }
  const start = firstInstant(date);
  const end = firstInstant(tomorrow.toISOString().slice(0, 10));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || queueLocalDate(start, timezone) !== date) {
    throw new ConflictException({ code: 'QUEUE_INVALID_LOCAL_DAY', message: 'This local service date cannot be resolved.' });
  }
  return { start, end };
}

export function assertCheckInEligible(record: { status: string; startsAt: Date }, timezone: string, now: Date) {
  if (record.status !== 'scheduled') {
    throw new ConflictException({ code: 'QUEUE_BOOKING_INELIGIBLE', message: 'Only scheduled appointments can check in.' });
  }
  if (queueLocalDate(record.startsAt, timezone) !== queueLocalDate(now, timezone)) {
    throw new ConflictException({ code: 'QUEUE_WRONG_SERVICE_DATE', message: 'Check-in is available on the appointment’s local service date.' });
  }
  // No minute-based early-arrival window was specified in the approved blueprint.
}

export function decodeQueueCursor(cursor?: string): { version: number; offset: number } | null {
  if (!cursor) return null;
  const [version, offset] = cursor.split(':').map(Number);
  return { version, offset };
}
