import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appointmentAttendance, appointmentHistory, doctorDailyQueue, doctorProfile, payment } from '../db/schema.js';
import { AppointmentReminderService } from '../notifications/appointment-reminder.service.js';
import { queueLocalDate } from './appointment-queue-policy.js';
import { attendanceForAppointment, bumpQueueVersion, lockDailyQueue, queuesForBooking, queueTimezone, reserveBookingToken, type QueueTransaction, type QueueAttendance } from './appointment-queue-store.js';

export interface QueueBooking { id: string; doctorId: string; startsAt: Date; status: string }

@Injectable()
export class AppointmentQueueLifecycleService {
  constructor(@Optional() private readonly reminders?: AppointmentReminderService) {}

  // Capture may revive an expired hold and acquire the doctor-capacity lock.
  // Take that lock BEFORE payment/appointment locks, matching rescheduling and
  // booking. The invoice lookup itself is deliberately unlocked.
  async lockPaymentDoctor(tx: QueueTransaction, orderId: string) {
    const [invoice] = await tx.select({ doctorId: payment.doctorId }).from(payment).where(eq(payment.razorpayOrderId, orderId)).limit(1);
    if (invoice) await tx.select({ id: doctorProfile.id }).from(doctorProfile).where(eq(doctorProfile.userId, invoice.doctorId)).for('update').limit(1);
  }

  async canRestoreCancelledBooking(tx: QueueTransaction, appointmentId: string) {
    return !await attendanceForAppointment(tx, appointmentId);
  }

  // Every caller must already hold its appointment lock. These helpers never
  // acquire payment, appointment or profile locks after a queue lock.
  async assertReschedulable(tx: QueueTransaction, record: QueueBooking) {
    if (await attendanceForAppointment(tx, record.id)) {
      throw new ConflictException({ code: 'QUEUE_RESCHEDULE_BLOCKED', message: 'An appointment with attendance cannot be rescheduled. Staff review is required.' });
    }
  }

  async reserveBookingToken(tx: QueueTransaction, record: QueueBooking, now = new Date()) {
    return reserveBookingToken(tx, record, now);
  }

  async bookingChanged(tx: QueueTransaction, records: QueueBooking[], now = new Date(), reserveTokens = true) {
    const buckets = new Map<string, { doctorId: string; date: string; timezone: string }>();
    for (const record of records) {
      if (record.status !== 'scheduled' && record.status !== 'pending_payment') continue;
      const existing = await queuesForBooking(tx, record);
      if (existing.length) {
        for (const queue of existing) buckets.set(`${queue.doctorId}:${queue.serviceDate}`, { doctorId: queue.doctorId, date: queue.serviceDate, timezone: queue.timezone });
        continue;
      }
      const timezone = await queueTimezone(tx, record.doctorId);
      const date = queueLocalDate(record.startsAt, timezone);
      buckets.set(`${record.doctorId}:${date}`, { doctorId: record.doctorId, date, timezone });
    }
    for (const key of [...buckets.keys()].sort()) {
      const bucket = buckets.get(key)!;
      const queue = await lockDailyQueue(tx, bucket.doctorId, bucket.date, bucket.timezone, now, false);
      await bumpQueueVersion(tx, queue.id, now);
    }
    if (reserveTokens) {
      const latest = new Map(records.map(record => [record.id, record]));
      for (const record of latest.values()) {
        if (record.status === 'scheduled' || record.status === 'pending_payment') await reserveBookingToken(tx, record, now);
      }
    }
  }

  private async close(tx: QueueTransaction, record: QueueBooking, status: 'cancelled' | 'completed', actorId: string) {
    const attendance = await attendanceForAppointment(tx, record.id);
    const now = new Date();
    if (!attendance) { await this.bookingChanged(tx, [record], now, false); return; }
    if (attendance.doctorId !== record.doctorId || attendance.appointmentStartsAt.getTime() !== record.startsAt.getTime()) {
      throw new ConflictException({ code: 'QUEUE_ATTENDANCE_STALE', message: 'Attendance no longer matches this booking.' });
    }
    if (status === 'completed' && attendance.status !== 'in_service') {
      throw new ConflictException({ code: 'QUEUE_NOT_IN_SERVICE', message: 'Start this consultation before completing it.' });
    }
    if (attendance.status === 'completed' || attendance.status === 'cancelled') {
      throw new ConflictException({ code: 'QUEUE_ATTENDANCE_TERMINAL', message: 'Attendance is already closed.' });
    }
    if ((attendance.startedAt && attendance.startedAt > now) || (attendance.checkedInAt && attendance.checkedInAt > now)) {
      throw new ConflictException({ code: 'QUEUE_CLOCK_CHANGED', message: 'Server time precedes the attendance event. Retry after checking the clock.' });
    }
    await bumpQueueVersion(tx, attendance.queueId, now);
    const [updated] = await tx.update(appointmentAttendance).set({ status, terminalAt: now, terminalBy: actorId,
      version: sql`${appointmentAttendance.version} + 1`, updatedAt: now })
      .where(and(eq(appointmentAttendance.appointmentId, record.id), eq(appointmentAttendance.version, attendance.version), lt(appointmentAttendance.version, 2147483647)))
      .returning({ id: appointmentAttendance.appointmentId });
    if (!updated) throw new ConflictException({ code: 'QUEUE_CONCURRENT_CHANGE', message: 'Attendance changed. Refresh and retry.' });
    await tx.insert(appointmentHistory).values({ id: randomUUID(), appointmentId: record.id, actorId,
      action: status === 'completed' ? 'queue_completed' : 'queue_cancelled', createdAt: now });
  }

  async cancelled(tx: QueueTransaction, record: QueueBooking, actorId: string) { await this.close(tx, record, 'cancelled', actorId); }
  async completed(tx: QueueTransaction, record: QueueBooking, actorId: string) { await this.close(tx, record, 'completed', actorId); }

  async start(tx: QueueTransaction, attendance: QueueAttendance, actorId: string, expectedQueueVersion: number, now: Date) {
    if (attendance.status !== 'waiting' || !attendance.checkedInAt || now < attendance.checkedInAt) {
      throw new ConflictException({ code: 'QUEUE_NOT_WAITING', message: 'This attendance cannot be started.' });
    }
    const [queue] = await tx.select().from(doctorDailyQueue).where(eq(doctorDailyQueue.id, attendance.queueId)).for('update').limit(1);
    if (!queue || queue.version !== expectedQueueVersion) {
      throw new ConflictException({ code: 'QUEUE_VERSION_CHANGED', message: 'The queue changed. Refresh before starting the next patient.' });
    }
    await bumpQueueVersion(tx, queue.id, now);
    const [updated] = await tx.update(appointmentAttendance).set({ status: 'in_service', startedAt: now, startedBy: actorId,
      version: sql`${appointmentAttendance.version} + 1`, updatedAt: now })
      .where(and(eq(appointmentAttendance.appointmentId, attendance.appointmentId), eq(appointmentAttendance.status, 'waiting'), eq(appointmentAttendance.version, attendance.version), lt(appointmentAttendance.version, 2147483647)))
      .returning({ id: appointmentAttendance.appointmentId });
    if (!updated) throw new ConflictException({ code: 'QUEUE_CONCURRENT_CHANGE', message: 'Attendance changed. Refresh and retry.' });
    await tx.insert(appointmentHistory).values({ id: randomUUID(), appointmentId: attendance.appointmentId, actorId, action: 'consultation_started', createdAt: now });
  }

  async noShow(tx: QueueTransaction, record: QueueBooking, timezone: string, actorId: string, now: Date, reason?: string) {
    const queue = await lockDailyQueue(tx, record.doctorId, queueLocalDate(record.startsAt, timezone), timezone, now);
    await bumpQueueVersion(tx, queue.id, now);
    await tx.insert(appointmentAttendance).values({ appointmentId: record.id, queueId: queue.id, doctorId: record.doctorId,
      appointmentStartsAt: record.startsAt, status: 'no_show', terminalAt: now, terminalBy: actorId, createdAt: now, updatedAt: now });
    await tx.insert(appointmentHistory).values({ id: randomUUID(), appointmentId: record.id, actorId, action: 'marked_no_show', reason, createdAt: now });
    await this.reminders?.cancelForAppointment(tx, record.id);
  }
}
