import { ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { StaffAccessService } from '../auth/staff-access.service.js';
import { doctorProfile, staffDoctorAssignment, user } from '../db/schema.js';
import * as store from './appointment-queue-store.js';
import { assertCheckInEligible, decodeQueueCursor, queueDayBounds, queueLocalDate } from './appointment-queue-policy.js';
import type { QueueReadInput, QueueNextInput, QueueNoShowInput } from './appointment-queue.schema.js';
import { AppointmentQueueLifecycleService } from './appointment-queue-lifecycle.service.js';
import { loadEnv } from '../config/env.js';

@Injectable()
export class AppointmentQueueService {
  constructor(private readonly staff: StaffAccessService, @Optional() private readonly lifecycle?: AppointmentQueueLifecycleService) {}

  private lifecycleService() {
    if (!this.lifecycle) throw new ServiceUnavailableException('Queue lifecycle is unavailable.');
    return this.lifecycle;
  }

  async next(actor: AuthenticatedUser, doctorId: string, input: QueueNextInput) {
    if (actor.role !== 'doctor') throw new ForbiddenException();
    const lifecycle = this.lifecycleService();
    return store.queueTransaction(async tx => {
      await this.authorize(tx, actor, doctorId);
      const queue = await store.dailyQueue(tx, doctorId, input.serviceDate);
      if (!queue || queue.version !== input.expectedQueueVersion) throw new ConflictException({ code: 'QUEUE_VERSION_CHANGED', message: 'Refresh the queue before starting the next patient.' });
      if (await store.currentAttendance(tx, doctorId)) throw new ConflictException({ code: 'QUEUE_CURRENT_ACTIVE', message: 'Complete or cancel the current consultation first.' });
      const candidate = await store.firstWaiting(tx, queue.id);
      if (!candidate) throw new ConflictException({ code: 'QUEUE_EMPTY', message: 'There are no checked-in patients waiting.' });
      const record = await store.queueAppointment(tx, candidate.appointmentId, true);
      const attendance = await store.attendanceForAppointment(tx, candidate.appointmentId);
      if (!record || !attendance || record.status !== 'scheduled' || record.doctorId !== doctorId || attendance.queueId !== queue.id || attendance.status !== 'waiting'
        || attendance.appointmentStartsAt.getTime() !== record.startsAt.getTime()) {
        throw new ConflictException({ code: 'QUEUE_BOOKING_CHANGED', message: 'This appointment changed. Refresh the queue.' });
      }
      // Candidate appointment first, queue second; a stale candidate causes a new
      // transaction, never locking another appointment while holding a queue lock.
      await lifecycle.start(tx, attendance, actor.id, input.expectedQueueVersion, new Date());
      const [row] = await store.ownAttendanceRows(tx, record.patientId, [record.id]);
      return this.summary(row);
    }, true);
  }

  async noShow(actor: AuthenticatedUser, appointmentId: string, input: QueueNoShowInput) {
    if (actor.role !== 'doctor' && actor.role !== 'staff') throw new ForbiddenException();
    const lifecycle = this.lifecycleService();
    return store.queueTransaction(async tx => {
      const candidate = await store.queueAppointment(tx, appointmentId);
      if (!candidate) throw new NotFoundException('Appointment not found.');
      await this.authorize(tx, actor, candidate.doctorId);
      const record = await store.queueAppointment(tx, appointmentId, true);
      if (!record || record.doctorId !== candidate.doctorId || record.status !== 'scheduled') throw new ConflictException({ code: 'QUEUE_BOOKING_INELIGIBLE', message: 'Only scheduled appointments can be marked absent.' });
      const existing = await store.attendanceForAppointment(tx, appointmentId);
      if (input.expectedAttendanceVersion !== undefined && input.expectedAttendanceVersion !== (existing?.version ?? 0)) {
        throw new ConflictException({ code: 'QUEUE_ATTENDANCE_CHANGED', message: 'Attendance changed. Refresh and retry.' });
      }
      if (existing && (existing.status !== 'no_show' || existing.appointmentStartsAt.getTime() !== record.startsAt.getTime() || existing.doctorId !== record.doctorId)) {
        throw new ConflictException({ code: 'QUEUE_ALREADY_ATTENDED', message: 'This patient already has attendance. Use the consultation workflow.' });
      }
      if (!existing) {
        const grace = loadEnv().queueNoShowGraceMinutes;
        if (grace === undefined) throw new ServiceUnavailableException({ code: 'QUEUE_NO_SHOW_NOT_CONFIGURED', message: 'Configure the approved no-show grace period before marking patients absent.' });
        const now = new Date();
        if (now.getTime() < record.startsAt.getTime() + grace * 60000) throw new ConflictException({ code: 'QUEUE_NO_SHOW_TOO_EARLY', message: 'The approved no-show grace period has not elapsed.' });
        await lifecycle.noShow(tx, record, await store.queueTimezone(tx, record.doctorId), actor.id, now, input.reason);
      }
      const [row] = await store.ownAttendanceRows(tx, record.patientId, [record.id]);
      return this.summary(row);
    }, true);
  }

  private async authorize(tx: store.QueueTransaction, actor: AuthenticatedUser, doctorId: string) {
    if (actor.role === 'staff') return this.staff.assertAssigned(tx, actor, doctorId);
    if (actor.role !== 'doctor') throw new ForbiddenException();
    if (actor.id !== doctorId) throw new NotFoundException('Queue not found.');
    // Match existing schedule writers: doctor approval locks precede appointments.
    const [doctor] = await tx.select({ id: user.id }).from(user)
      .where(and(eq(user.id, actor.id), eq(user.role, 'doctor'))).for('share').limit(1);
    const [profile] = await tx.select({ id: doctorProfile.id }).from(doctorProfile)
      .where(and(eq(doctorProfile.userId, doctorId), eq(doctorProfile.status, 'approved'))).for('share').limit(1);
    if (!doctor || !profile) throw new ForbiddenException('An approved doctor is required.');
  }

  private summary(row: Awaited<ReturnType<typeof store.ownAttendanceRows>>[number]) {
    const attendance = row.attendance;
    const status = attendance ? (row.bookingStatus === 'cancelled' || row.bookingStatus === 'completed' ? row.bookingStatus : attendance.status) : 'not_checked_in';
    return { appointmentId: row.appointmentId, status, tokenNumber: attendance?.tokenNumber ?? null,
      position: status === 'waiting' ? row.position : null,
      checkedInAt: attendance?.checkedInAt ?? null, startedAt: attendance?.startedAt ?? null,
      serviceDate: row.queue?.serviceDate ?? null, timezone: row.queue?.timezone ?? null,
      version: attendance?.version ?? null, queueVersion: row.queue?.version ?? 0 };
  }

  async checkIn(actor: AuthenticatedUser, appointmentId: string) {
    if (actor.role !== 'doctor' && actor.role !== 'staff') throw new ForbiddenException();
    return store.queueTransaction(async tx => {
      const candidate = await store.queueAppointment(tx, appointmentId);
      if (!candidate) throw new NotFoundException('Appointment not found.');
      await this.authorize(tx, actor, candidate.doctorId);
      const record = await store.queueAppointment(tx, appointmentId, true);
      if (!record || record.doctorId !== candidate.doctorId) throw new ConflictException({ code: 'QUEUE_BOOKING_CHANGED', message: 'The appointment changed. Refresh and retry.' });
      if (record.status !== 'scheduled') throw new ConflictException({ code: 'QUEUE_BOOKING_INELIGIBLE', message: 'Only scheduled appointments can check in.' });
      const existing = await store.attendanceForAppointment(tx, appointmentId);
      if (existing) {
        if (existing.doctorId !== record.doctorId || existing.appointmentStartsAt.getTime() !== record.startsAt.getTime()) {
          throw new ConflictException({ code: 'QUEUE_ATTENDANCE_STALE', message: 'The appointment was rescheduled after check-in. Staff review is required.' });
        }
        if (existing.status !== 'waiting' && existing.status !== 'in_service') {
          throw new ConflictException({ code: 'QUEUE_ATTENDANCE_TERMINAL', message: 'This attendance is already closed.' });
        }
        const [row] = await store.ownAttendanceRows(tx, record.patientId, [appointmentId]);
        return this.summary(row);
      }
      const timezone = await store.queueTimezone(tx, record.doctorId);
      const now = new Date();
      assertCheckInEligible(record, timezone, now);
      const serviceDate = queueLocalDate(record.startsAt, timezone);
      // Appointment lock is held BEFORE obtaining the queue lock. Never reverse it.
      const allocated = await store.allocateQueueToken(tx, record.doctorId, serviceDate, timezone, now);
      await store.insertCheckIn(tx, { appointmentId, doctorId: record.doctorId, queueId: allocated.queue.id,
        appointmentStartsAt: record.startsAt, status: 'waiting', tokenNumber: allocated.tokenNumber,
        checkedInAt: now, checkedInBy: actor.id, createdAt: now, updatedAt: now }, actor.id, now);
      const [row] = await store.ownAttendanceRows(tx, record.patientId, [appointmentId]);
      return this.summary(row);
    }, true);
  }

  async ownAttendance(actor: AuthenticatedUser, ids: string[]) {
    if (actor.role !== 'patient') throw new ForbiddenException();
    return store.queueTransaction(async tx => {
      const rows = await store.ownAttendanceRows(tx, actor.id, ids);
      if (rows.length !== ids.length) throw new NotFoundException('Appointment not found.');
      return { appointments: rows.map(row => this.summary(row)) };
    });
  }

  async read(actor: AuthenticatedUser, input: QueueReadInput) {
    return store.queueTransaction(async tx => {
      await this.authorize(tx, actor, input.doctorId);
      const queue = await store.dailyQueue(tx, input.doctorId, input.date);
      const timezone = queue?.timezone ?? await store.queueTimezone(tx, input.doctorId);
      const version = queue?.version ?? 0;
      const cursor = decodeQueueCursor(input.cursor);
      if (cursor && cursor.version !== version) throw new ConflictException({ code: 'QUEUE_VERSION_CHANGED', message: 'The queue changed. Refresh from the first page.' });
      const bounds = queueDayBounds(input.date, timezone);
      const page = await store.readQueuePage(tx, input.doctorId, queue?.id, bounds.start, bounds.end, input.limit, cursor?.offset ?? 0);
      const hasMoreWaiting = page.waiting.length > input.limit;
      const hasMoreExpected = page.expected.length > input.limit;
      const closed = page.closed ?? [];
      const hasMoreClosed = closed.length > input.limit;
      return { doctorId: input.doctorId, serviceDate: input.date, timezone, version,
        current: page.current, waitingCount: page.waitingCount,
        waiting: page.waiting.slice(0, input.limit), expected: page.expected.slice(0, input.limit),
        closed: closed.slice(0, input.limit), hasMoreWaiting, hasMoreExpected, hasMoreClosed,
        nextCursor: hasMoreWaiting || hasMoreExpected || hasMoreClosed ? `${version}:${(cursor?.offset ?? 0) + input.limit}` : null };
    });
  }

  async assignments(actor: AuthenticatedUser) {
    if (actor.role !== 'staff' && actor.role !== 'doctor') throw new ForbiddenException();
    return store.queueTransaction(async tx => {
      if (actor.role === 'doctor') {
        await this.authorize(tx, actor, actor.id);
        return [{ doctorId: actor.id, name: actor.name }];
      }
      const [staff] = await tx.select({ id: user.id }).from(user)
        .where(and(eq(user.id, actor.id), eq(user.role, 'staff'))).for('share').limit(1);
      if (!staff) throw new ForbiddenException();
      return tx.select({ doctorId: user.id, name: user.name }).from(staffDoctorAssignment)
        .innerJoin(user, eq(user.id, staffDoctorAssignment.doctorId))
        .innerJoin(doctorProfile, eq(doctorProfile.userId, user.id))
        .where(and(eq(staffDoctorAssignment.staffId, actor.id), isNull(staffDoctorAssignment.revokedAt),
          eq(user.role, 'doctor'), eq(doctorProfile.status, 'approved'))).orderBy(asc(user.name), asc(user.id));
    });
  }
}
