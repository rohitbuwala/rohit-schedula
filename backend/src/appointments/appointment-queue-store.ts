import { ConflictException, HttpException, InternalServerErrorException } from '@nestjs/common';
import { and, asc, eq, getTableColumns, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { alias } from 'drizzle-orm/pg-core';
import { setTimeout as pause } from 'node:timers/promises';
import { db } from '../db/database.js';
import { appointment, appointmentAttendance, appointmentBookingToken, appointmentHistory, doctorAvailability, doctorDailyQueue, user } from '../db/schema.js';
import { queueLocalDate } from './appointment-queue-policy.js';
import { DEFAULT_TIMEZONE } from './appointment-availability.js';

export type QueueTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type QueueAttendance = typeof appointmentAttendance.$inferSelect;

function databaseCode(error: unknown): string | undefined {
  let entry = error;
  for (let depth = 0; depth < 8 && entry && typeof entry === 'object'; depth++) {
    if ('code' in entry && typeof entry.code === 'string' && ['40001', '40P01', '23505'].includes(entry.code)) return entry.code;
    entry = 'cause' in entry ? entry.cause : undefined;
  }
}

export async function queueTransaction<T>(work: (tx: QueueTransaction) => Promise<T>, write = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(work, { isolationLevel: write ? 'serializable' : 'repeatable read' });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code = databaseCode(error);
      if (code === '40001' || code === '40P01') {
        if (attempt < 2) { await pause(5 * (attempt + 1)); continue; }
        throw new ConflictException({ code: 'QUEUE_CONCURRENT_CHANGE', message: 'The queue changed concurrently. Refresh and retry.' });
      }
      if (code === '23505') throw new ConflictException({ code: 'QUEUE_DUPLICATE', message: 'This queue record already exists. Refresh and retry.' });
      // Never propagate SQL, parameters, provider errors or their causes.
      throw new InternalServerErrorException({ code: 'QUEUE_UNAVAILABLE', message: 'Queue information is temporarily unavailable.' });
    }
  }
}

export async function queueTimezone(tx: QueueTransaction, doctorId: string) {
  const [saved] = await tx.select({ timezone: doctorAvailability.timezone }).from(doctorAvailability)
    .where(eq(doctorAvailability.doctorId, doctorId)).limit(1);
  try { return new Intl.DateTimeFormat('en', { timeZone: saved?.timezone ?? DEFAULT_TIMEZONE }).resolvedOptions().timeZone; }
  catch { throw new ConflictException({ code: 'QUEUE_TIMEZONE_INVALID', message: 'The doctor’s configured timezone is invalid.' }); }
}

export async function queueAppointment(tx: QueueTransaction, id: string, lock = false) {
  const query = tx.select({ id: appointment.id, doctorId: appointment.doctorId, patientId: appointment.patientId,
    startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status }).from(appointment).where(eq(appointment.id, id));
  const [record] = await (lock ? query.for('update') : query).limit(1);
  return record;
}

export async function attendanceForAppointment(tx: QueueTransaction, id: string) {
  const [record] = await tx.select().from(appointmentAttendance).where(eq(appointmentAttendance.appointmentId, id)).limit(1);
  return record;
}

export async function dailyQueue(tx: QueueTransaction, doctorId: string, serviceDate: string) {
  const [record] = await tx.select().from(doctorDailyQueue)
    .where(and(eq(doctorDailyQueue.doctorId, doctorId), eq(doctorDailyQueue.serviceDate, serviceDate))).limit(1);
  return record;
}

export async function queuesForBooking(tx: QueueTransaction, record: { doctorId: string; startsAt: Date }) {
  return tx.select().from(doctorDailyQueue).where(and(eq(doctorDailyQueue.doctorId, record.doctorId),
    eq(doctorDailyQueue.serviceDate, sql`(${record.startsAt.toISOString()}::timestamptz at time zone ${doctorDailyQueue.timezone})::date`)));
}

export async function lockDailyQueue(tx: QueueTransaction, doctorId: string, serviceDate: string, timezone: string, now: Date, strictTimezone = true) {
  await tx.insert(doctorDailyQueue).values({ id: randomUUID(), doctorId, serviceDate, timezone, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: [doctorDailyQueue.doctorId, doctorDailyQueue.serviceDate] });
  const [queue] = await tx.select().from(doctorDailyQueue)
    .where(and(eq(doctorDailyQueue.doctorId, doctorId), eq(doctorDailyQueue.serviceDate, serviceDate))).for('update').limit(1);
  if (!queue || (strictTimezone && queue.timezone !== timezone)) {
    throw new ConflictException({ code: 'QUEUE_TIMEZONE_CHANGED', message: 'The queue timezone differs from the current schedule. Refresh and review the service date.' });
  }
  return queue;
}

export async function bumpQueueVersion(tx: QueueTransaction, queueId: string, now: Date) {
  const [updated] = await tx.update(doctorDailyQueue).set({ version: sql`${doctorDailyQueue.version} + 1`, updatedAt: now })
    .where(and(eq(doctorDailyQueue.id, queueId), lt(doctorDailyQueue.version, 2147483647))).returning({ version: doctorDailyQueue.version });
  if (!updated) throw new ConflictException({ code: 'QUEUE_COUNTER_EXHAUSTED', message: 'The queue version cannot advance.' });
  return updated.version;
}

export async function allocateQueueToken(tx: QueueTransaction, doctorId: string, serviceDate: string, timezone: string, now: Date) {
  const queue = await lockDailyQueue(tx, doctorId, serviceDate, timezone, now);
  const [allocated] = await tx.update(doctorDailyQueue).set({
    nextTokenNumber: sql`${doctorDailyQueue.nextTokenNumber} + 1`, version: sql`${doctorDailyQueue.version} + 1`, updatedAt: now,
  }).where(and(eq(doctorDailyQueue.id, queue.id), lt(doctorDailyQueue.nextTokenNumber, 2147483647), lt(doctorDailyQueue.version, 2147483647)))
    .returning({ tokenNumber: sql<number>`${doctorDailyQueue.nextTokenNumber} - 1`, queueVersion: doctorDailyQueue.version });
  if (!allocated) throw new ConflictException({ code: 'QUEUE_COUNTER_EXHAUSTED', message: 'The queue counter cannot allocate another token.' });
  return { ...allocated, queue };
}

export async function insertCheckIn(tx: QueueTransaction, values: typeof appointmentAttendance.$inferInsert, actorId: string, now: Date) {
  await tx.insert(appointmentAttendance).values(values);
  await tx.insert(appointmentHistory).values({ id: randomUUID(), appointmentId: values.appointmentId,
    actorId, action: 'checked_in', createdAt: now });
}

export async function bookingTokenForAppointment(tx: QueueTransaction, id: string) {
  const [token] = await tx.select({ ...getTableColumns(appointmentBookingToken),
    serviceDate: doctorDailyQueue.serviceDate, timezone: doctorDailyQueue.timezone,
  }).from(appointmentBookingToken).innerJoin(doctorDailyQueue, eq(doctorDailyQueue.id, appointmentBookingToken.queueId))
    .where(eq(appointmentBookingToken.appointmentId, id)).limit(1);
  return token;
}

// Caller holds the booking/profile lock. Payment retries keep the same token;
// rescheduling within a service date keeps it too. A new date gets a new token.
export async function reserveBookingToken(tx: QueueTransaction, record: { id: string; doctorId: string; startsAt: Date }, now: Date) {
  const existing = await bookingTokenForAppointment(tx, record.id);
  if (existing?.doctorId === record.doctorId && existing.serviceDate === queueLocalDate(record.startsAt, existing.timezone)) {
    if (existing.appointmentStartsAt.getTime() !== record.startsAt.getTime()) {
      await tx.update(appointmentBookingToken).set({ appointmentStartsAt: record.startsAt }).where(eq(appointmentBookingToken.appointmentId, record.id));
    }
    return existing;
  }
  const timezone = await queueTimezone(tx, record.doctorId);
  const allocated = await allocateQueueToken(tx, record.doctorId, queueLocalDate(record.startsAt, timezone), timezone, now);
  const values = { appointmentId: record.id, doctorId: record.doctorId, queueId: allocated.queue.id,
    appointmentStartsAt: record.startsAt, tokenNumber: allocated.tokenNumber, createdAt: now };
  await tx.insert(appointmentBookingToken).values(values).onConflictDoUpdate({ target: appointmentBookingToken.appointmentId, set: values });
  return { ...values, serviceDate: allocated.queue.serviceDate, timezone: allocated.queue.timezone };
}

// All queue reads join the authoritative booking. Before PR-3 lifecycle wiring,
// cancelled/completed/rescheduled bookings must never remain in the live queue.
const matchingBooking = and(eq(appointment.id, appointmentAttendance.appointmentId),
  eq(appointment.doctorId, appointmentAttendance.doctorId), eq(appointment.startsAt, appointmentAttendance.appointmentStartsAt));
const liveWaiting = and(eq(appointmentAttendance.status, 'waiting'), eq(appointment.status, 'scheduled'));

export async function firstWaiting(tx: QueueTransaction, queueId: string) {
  const [record] = await tx.select({ appointmentId: appointment.id }).from(appointmentAttendance)
    .innerJoin(appointment, matchingBooking).where(and(liveWaiting, eq(appointmentAttendance.queueId, queueId)))
    .orderBy(asc(appointmentAttendance.checkedInAt), asc(appointment.id)).limit(1);
  return record;
}

export async function currentAttendance(tx: QueueTransaction, doctorId: string) {
  const [record] = await tx.select({ appointmentId: appointmentAttendance.appointmentId }).from(appointmentAttendance)
    .where(and(eq(appointmentAttendance.doctorId, doctorId), eq(appointmentAttendance.status, 'in_service'))).limit(1);
  return record;
}

function rankedWaiting(tx: QueueTransaction, scope: SQL | undefined) {
  return tx.select({ appointmentId: appointmentAttendance.appointmentId,
    position: sql<number>`row_number() over (partition by ${appointmentAttendance.queueId} order by ${appointmentAttendance.checkedInAt}, ${appointmentAttendance.appointmentId})`.mapWith(Number).as('position'),
  }).from(appointmentAttendance).innerJoin(appointment, matchingBooking).where(and(liveWaiting, scope)).as('ranked_waiting');
}

export async function ownAttendanceRows(tx: QueueTransaction, patientId: string, ids: string[]) {
  const relevantQueues = tx.select({ queueId: appointmentAttendance.queueId }).from(appointmentAttendance)
    .innerJoin(appointment, matchingBooking).where(and(eq(appointment.patientId, patientId), inArray(appointment.id, ids)));
  const ranked = rankedWaiting(tx, inArray(appointmentAttendance.queueId, relevantQueues));
  const serving = alias(appointmentAttendance, 'serving_attendance');
  const servingBooking = alias(appointment, 'serving_booking');
  const servingToken = tx.select({ token: serving.tokenNumber }).from(serving)
    .innerJoin(servingBooking, and(eq(servingBooking.id, serving.appointmentId),
      eq(servingBooking.doctorId, serving.doctorId), eq(servingBooking.startsAt, serving.appointmentStartsAt)))
    .where(and(eq(serving.queueId, doctorDailyQueue.id), eq(serving.status, 'in_service'),
      eq(servingBooking.status, 'scheduled'))).limit(1);
  return tx.select({ appointmentId: appointment.id, bookingStatus: appointment.status,
    bookingTokenNumber: appointmentBookingToken.tokenNumber,
    currentTokenNumber: sql<number | null>`(${servingToken})`.mapWith(Number),
    attendance: getTableColumns(appointmentAttendance), position: ranked.position,
    queue: { serviceDate: doctorDailyQueue.serviceDate, timezone: doctorDailyQueue.timezone, version: doctorDailyQueue.version },
  }).from(appointment).leftJoin(appointmentAttendance, matchingBooking)
    .leftJoin(appointmentBookingToken, and(eq(appointmentBookingToken.appointmentId, appointment.id),
      eq(appointmentBookingToken.doctorId, appointment.doctorId), eq(appointmentBookingToken.appointmentStartsAt, appointment.startsAt)))
    .leftJoin(doctorDailyQueue, eq(doctorDailyQueue.id, sql`coalesce(${appointmentAttendance.queueId}, ${appointmentBookingToken.queueId})`))
    .leftJoin(ranked, eq(ranked.appointmentId, appointment.id))
    .where(and(eq(appointment.patientId, patientId), inArray(appointment.id, ids))).orderBy(asc(appointment.id));
}

export async function readQueuePage(tx: QueueTransaction, doctorId: string, queueId: string | undefined, start: Date, end: Date, limit: number, offset: number) {
  const ranked = rankedWaiting(tx, eq(appointmentAttendance.queueId, queueId ?? ''));
  const waitingPredicate = and(liveWaiting, eq(appointmentAttendance.queueId, queueId ?? ''));
  const waiting = await tx.select({ appointmentId: appointment.id, patientName: user.name,
    startsAt: appointment.startsAt, endsAt: appointment.endsAt, tokenNumber: appointmentAttendance.tokenNumber,
    checkedInAt: appointmentAttendance.checkedInAt, status: appointmentAttendance.status, position: ranked.position,
  }).from(appointmentAttendance).innerJoin(appointment, matchingBooking).innerJoin(user, eq(user.id, appointment.patientId))
    .innerJoin(ranked, eq(ranked.appointmentId, appointment.id)).where(waitingPredicate)
    .orderBy(asc(appointmentAttendance.checkedInAt), asc(appointment.id)).limit(limit + 1).offset(offset);
  const [count] = await tx.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(appointmentAttendance)
    .innerJoin(appointment, matchingBooking).where(waitingPredicate);
  const current = await tx.select({ appointmentId: appointment.id, patientName: user.name,
    startsAt: appointment.startsAt, endsAt: appointment.endsAt, tokenNumber: appointmentAttendance.tokenNumber,
    checkedInAt: appointmentAttendance.checkedInAt, startedAt: appointmentAttendance.startedAt,
    serviceDate: doctorDailyQueue.serviceDate, timezone: doctorDailyQueue.timezone, status: appointmentAttendance.status,
  }).from(appointmentAttendance).innerJoin(appointment, matchingBooking).innerJoin(user, eq(user.id, appointment.patientId))
    .innerJoin(doctorDailyQueue, eq(doctorDailyQueue.id, appointmentAttendance.queueId))
    .where(and(eq(appointmentAttendance.doctorId, doctorId), eq(appointmentAttendance.status, 'in_service'), eq(appointment.status, 'scheduled'))).limit(1);
  const expected = await tx.select({ appointmentId: appointment.id, patientName: user.name,
    startsAt: appointment.startsAt, endsAt: appointment.endsAt, tokenNumber: appointmentBookingToken.tokenNumber,
  }).from(appointment).innerJoin(user, eq(user.id, appointment.patientId)).leftJoin(appointmentAttendance, matchingBooking)
    .leftJoin(appointmentBookingToken, and(eq(appointmentBookingToken.appointmentId, appointment.id),
      eq(appointmentBookingToken.doctorId, appointment.doctorId), eq(appointmentBookingToken.appointmentStartsAt, appointment.startsAt)))
    .where(and(eq(appointment.doctorId, doctorId), eq(appointment.status, 'scheduled'),
      gte(appointment.startsAt, start), lt(appointment.startsAt, end), isNull(appointmentAttendance.appointmentId)))
    .orderBy(asc(appointment.startsAt), asc(appointment.id)).limit(limit + 1).offset(offset);
  const closed = await tx.select({ appointmentId: appointment.id, patientName: user.name,
    startsAt: appointment.startsAt, endsAt: appointment.endsAt,
    tokenNumber: sql<number | null>`coalesce(${appointmentAttendance.tokenNumber}, ${appointmentBookingToken.tokenNumber})`.mapWith(Number),
    status: appointmentAttendance.status, startedAt: appointmentAttendance.startedAt, terminalAt: appointmentAttendance.terminalAt,
  }).from(appointmentAttendance).innerJoin(appointment, matchingBooking).innerJoin(user, eq(user.id, appointment.patientId))
    .leftJoin(appointmentBookingToken, and(eq(appointmentBookingToken.appointmentId, appointment.id),
      eq(appointmentBookingToken.doctorId, appointment.doctorId), eq(appointmentBookingToken.appointmentStartsAt, appointment.startsAt)))
    .where(and(eq(appointmentAttendance.queueId, queueId ?? ''), inArray(appointmentAttendance.status, ['completed', 'cancelled', 'no_show'])))
    .orderBy(asc(appointment.startsAt), asc(appointment.id)).limit(limit + 1).offset(offset);
  return { waiting, waitingCount: count?.count ?? 0, current: current[0] ?? null, expected, closed };
}
