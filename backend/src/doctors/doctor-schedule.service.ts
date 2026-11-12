import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, gt, inArray, lt, ne, or } from 'drizzle-orm';
import { db } from '../db/database.js';
import {
  appointment,
  doctorAvailability,
  doctorLeave,
  doctorScheduleOverride,
  doctorProfile,
  payment,
  scheduleChangeAlternative,
  scheduleChangeAppointment,
  scheduleChangeRequest,
  user,
} from '../db/schema.js';
import {
  findCapacityConflicts,
  getAvailableSlotsWithCapacity,
  getBookableRescheduleWindow,
  getDurationForDate,
  isAppointmentCompatibleWithSchedule,
  isBookableSlot,
} from '../appointments/appointment-availability.js';
import type { DoctorScheduleConfig } from '../appointments/appointment-availability.js';
import { doctorScheduleUpdateSchema, type DoctorScheduleUpdate, type DoctorLeaveInput, type DoctorScheduleOverrideInput } from './doctor-schedule.schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export interface DoctorLeaveRecord {
  id: string;
  date: string;
  reason?: string;
  createdAt: string;
}

export interface DoctorScheduleOverrideRecord {
  id: string;
  date: string;
  startHour: number;
  endHour: number;
  slotDurationMinutes: number;
  schedulingMode: 'wave' | 'stream' | null;
  capacity: number | null;
  breakStart: string | null;
  breakEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DoctorScheduleData {
  timezone: string;
  activeDays: number[];
  startHour: number;
  endHour: number;
  slotDurationMinutes: number;
  schedulingMode: 'wave' | 'stream';
  capacity: number;
  breakStart: string | null;
  breakEnd: string | null;
  leaves: DoctorLeaveRecord[];
  overrides: DoctorScheduleOverrideRecord[];
}

const DEFAULT_SCHEDULE = {
  timezone: 'Asia/Kolkata',
  activeDays: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 17,
  slotDurationMinutes: 30,
  schedulingMode: 'stream' as const,
  capacity: 1,
  breakStart: null,
  breakEnd: null,
} as const;

const REQUEST_EXPIRY_MS = 24 * 60 * 60 * 1000;
const ALTERNATIVE_SEARCH_DAYS = 90;
const MAX_ALTERNATIVES_PER_APPOINTMENT = 5;

@Injectable()
export class DoctorScheduleService {
  constructor(private readonly notifications?: NotificationsService) {}
  private async lockSchedule(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], doctorId: string): Promise<void> {
    await tx.select({ id: doctorProfile.id }).from(doctorProfile)
      .where(eq(doctorProfile.userId, doctorId)).for('update').limit(1);
  }

  async getSchedule(doctorId: string): Promise<DoctorScheduleData> {
    const [saved] = await db.select().from(doctorAvailability)
      .where(eq(doctorAvailability.doctorId, doctorId)).limit(1);
    const leaves = await db.select().from(doctorLeave)
      .where(eq(doctorLeave.doctorId, doctorId)).orderBy(asc(doctorLeave.date));
    const overrides = await db.select().from(doctorScheduleOverride)
      .where(eq(doctorScheduleOverride.doctorId, doctorId)).orderBy(asc(doctorScheduleOverride.date));

    return {
      ...DEFAULT_SCHEDULE,
      ...(saved ? {
        timezone: saved.timezone,
        activeDays: saved.activeDays,
        startHour: saved.startHour,
        endHour: saved.endHour,
        slotDurationMinutes: saved.slotDurationMinutes,
        schedulingMode: saved.schedulingMode as 'wave' | 'stream',
        capacity: saved.capacity,
        breakStart: saved.breakStart,
        breakEnd: saved.breakEnd,
      } : {}),
      activeDays: saved ? [...saved.activeDays] : [...DEFAULT_SCHEDULE.activeDays],
      leaves: leaves.map((leave) => ({
        id: leave.id,
        date: leave.date,
        ...(leave.reason ? { reason: leave.reason } : {}),
        createdAt: leave.createdAt.toISOString(),
      })),
      overrides: overrides.map((override) => ({
        id: override.id,
        date: override.date,
        startHour: override.startHour,
        endHour: override.endHour,
        slotDurationMinutes: override.slotDurationMinutes,
        schedulingMode: override.schedulingMode as 'wave' | 'stream' | null,
        capacity: override.capacity,
        breakStart: override.breakStart,
        breakEnd: override.breakEnd,
        createdAt: override.createdAt.toISOString(),
        updatedAt: override.updatedAt.toISOString(),
      })),
    };
  }

  async getTimezoneForDoctor(doctorId: string): Promise<string> {
    const [saved] = await db.select({ timezone: doctorAvailability.timezone }).from(doctorAvailability)
      .where(eq(doctorAvailability.doctorId, doctorId)).limit(1);
    return saved?.timezone ?? DEFAULT_SCHEDULE.timezone;
  }

  async updateSchedule(doctorId: string, update: DoctorScheduleUpdate): Promise<DoctorScheduleData> {
    const now = new Date();
    await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      const conflicts = await this.findScheduleConflicts(tx, doctorId, update, now);
      if (conflicts.length > 0) {
        throw new ConflictException({
          message: 'The schedule change conflicts with existing future appointments or active payment holds.',
          conflicts,
        });
      }
      await tx.insert(doctorAvailability).values({
        id: randomUUID(),
        doctorId,
        timezone: update.timezone,
        activeDays: [...update.activeDays].sort((a, b) => a - b),
        startHour: update.startHour,
        endHour: update.endHour,
        slotDurationMinutes: update.slotDurationMinutes ?? 30,
        schedulingMode: update.schedulingMode,
        capacity: update.capacity,
        breakStart: update.breakStart ?? null,
        breakEnd: update.breakEnd ?? null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: doctorAvailability.doctorId,
        set: {
          timezone: update.timezone,
          activeDays: [...update.activeDays].sort((a, b) => a - b),
          startHour: update.startHour,
          endHour: update.endHour,
          slotDurationMinutes: update.slotDurationMinutes ?? 30,
          schedulingMode: update.schedulingMode,
          capacity: update.capacity,
          breakStart: update.breakStart ?? null,
          breakEnd: update.breakEnd ?? null,
          updatedAt: now,
        },
      });
    });
    return this.getSchedule(doctorId);
  }

  async createScheduleRequest(doctorId: string, update: DoctorScheduleUpdate) {
    const now = new Date();
    return db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      const [existing] = await tx.select({
        id: scheduleChangeRequest.id,
        expiresAt: scheduleChangeRequest.expiresAt,
      })
        .from(scheduleChangeRequest)
        .where(and(
          eq(scheduleChangeRequest.doctorId, doctorId),
          eq(scheduleChangeRequest.status, 'pending'),
        ))
        .limit(1);
      if (existing) {
        if (existing.expiresAt.getTime() <= now.getTime()) {
          await tx.update(scheduleChangeRequest)
            .set({ status: 'expired', expiredAt: now, updatedAt: now })
            .where(and(
              eq(scheduleChangeRequest.id, existing.id),
              eq(scheduleChangeRequest.status, 'pending'),
            ));
        } else {
          throw new ConflictException('A schedule change request is already pending for this doctor.');
        }
      }

      const conflicts = await this.findScheduleConflicts(tx, doctorId, update, now);
      const supportingData = await this.getScheduleSupportingData(tx, doctorId);
      const config = this.toScheduleConfig(update, supportingData.leaves, supportingData.overrides);
      const [request] = await tx.insert(scheduleChangeRequest).values({
        id: randomUUID(),
        doctorId,
        proposedSchedule: update,
        status: 'pending',
        expiresAt: new Date(now.getTime() + REQUEST_EXPIRY_MS),
        createdAt: now,
        updatedAt: now,
      }).returning();

      const affected = [];
      for (const conflict of conflicts) {
        const [affectedAppointment] = await tx.insert(scheduleChangeAppointment).values({
          id: randomUUID(),
          requestId: request.id,
          appointmentId: conflict.id,
          originalStartsAt: conflict.startsAt,
          originalEndsAt: conflict.endsAt,
          consentStatus: 'pending',
          resolutionStatus: 'pending',
          createdAt: now,
          updatedAt: now,
        }).returning();
        const alternatives = await this.generateAlternatives(
          tx,
          doctorId,
          conflict.id,
          conflict.startsAt,
          conflict.endsAt,
          config,
          now,
        );
        if (alternatives.length > 0) {
          await tx.insert(scheduleChangeAlternative).values(alternatives.map((slot, index) => ({
            id: randomUUID(),
            affectedAppointmentId: affectedAppointment.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            rank: index + 1,
            createdAt: now,
          })));
        }
        affected.push({ ...affectedAppointment, alternatives });
      }

      const result = {
        request,
        affectedAppointments: affected,
        hasConflicts: conflicts.length > 0,
      };
      return result;
    });
  }

  async getScheduleRequest(doctorId: string, requestId: string) {
    const [request] = await db.select().from(scheduleChangeRequest)
      .where(and(
        eq(scheduleChangeRequest.id, requestId),
        eq(scheduleChangeRequest.doctorId, doctorId),
      ))
      .limit(1);
    if (!request) throw new NotFoundException('Schedule change request not found.');

    const affectedAppointments = await db.select({
      affected: scheduleChangeAppointment,
      appointment: {
        id: appointment.id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
      },
      patient: {
        id: user.id,
        name: user.name,
      },
      payment: {
        status: payment.status,
      },
    }).from(scheduleChangeAppointment)
      .innerJoin(appointment, eq(appointment.id, scheduleChangeAppointment.appointmentId))
      .innerJoin(user, eq(user.id, appointment.patientId))
      .leftJoin(payment, eq(payment.appointmentId, appointment.id))
      .where(eq(scheduleChangeAppointment.requestId, requestId));
    const alternatives = affectedAppointments.length === 0
      ? []
      : await db.select().from(scheduleChangeAlternative)
        .where(inArray(
          scheduleChangeAlternative.affectedAppointmentId,
          affectedAppointments.map(({ affected }) => affected.id),
        ));
    return {
      request,
      affectedAppointments: affectedAppointments.map(({ affected, appointment: record, patient, payment: pay }) => ({
        ...affected,
        appointment: record,
        patient,
        payment: pay ? {
          status: pay.status,
          statusDisplay: pay.status === 'captured'
            ? 'Paid'
            : pay.status === 'refunded'
              ? 'Refunded'
              : pay.status === 'failed'
                ? 'Payment Failed'
                : 'Payment Pending',
        } : null,
        conflictReason: affected.originalStartsAt.getTime() === record.startsAt.getTime()
          && affected.originalEndsAt.getTime() === record.endsAt.getTime()
          ? record.status === 'pending_payment'
            ? 'Active payment hold falls outside the proposed schedule.'
            : 'Booked appointment falls outside the proposed schedule.'
          : 'Appointment changed after the schedule request was created.',
        alternatives: alternatives.filter((alternative) =>
          alternative.affectedAppointmentId === affected.id),
      })),
    };
  }

  async selectScheduleAlternatives(
    doctorId: string,
    requestId: string,
    affectedAppointmentId: string,
    alternativeIds: string[],
  ) {
    await db.transaction(async (tx) => {
      const [request] = await tx.select().from(scheduleChangeRequest)
        .where(and(
          eq(scheduleChangeRequest.id, requestId),
          eq(scheduleChangeRequest.doctorId, doctorId),
        ))
        .for('update')
        .limit(1);
      if (!request) throw new NotFoundException('Schedule change request not found.');
      if (request.status !== 'pending' || request.approvedAt) {
        throw new ConflictException('Only an unapproved schedule change request can be edited.');
      }

      const [affected] = await tx.select().from(scheduleChangeAppointment)
        .where(and(
          eq(scheduleChangeAppointment.id, affectedAppointmentId),
          eq(scheduleChangeAppointment.requestId, requestId),
        ))
        .for('update')
        .limit(1);
      if (!affected) throw new NotFoundException('Schedule change appointment not found.');
      if (affected.consentStatus !== 'pending' || affected.resolutionStatus !== 'pending') {
        throw new ConflictException('This appointment already has a recorded patient response.');
      }

      const selected = await tx.select().from(scheduleChangeAlternative)
        .where(and(
          eq(scheduleChangeAlternative.affectedAppointmentId, affectedAppointmentId),
          inArray(scheduleChangeAlternative.id, alternativeIds),
        ));
      if (selected.length !== alternativeIds.length) {
        throw new ConflictException('One or more selected alternatives are no longer available.');
      }

      await tx.delete(scheduleChangeAlternative)
        .where(eq(scheduleChangeAlternative.affectedAppointmentId, affectedAppointmentId));
      if (selected.length > 0) {
        await tx.insert(scheduleChangeAlternative).values(selected.map((alternative, index) => ({
          id: randomUUID(),
          affectedAppointmentId,
          startsAt: alternative.startsAt,
          endsAt: alternative.endsAt,
          rank: index + 1,
          selectedAt: null,
          createdAt: alternative.createdAt,
        })));
      }
    });
    return this.getScheduleRequest(doctorId, requestId);
  }

  async listScheduleRequests(doctorId: string) {
    const requests = await db.select().from(scheduleChangeRequest)
      .where(eq(scheduleChangeRequest.doctorId, doctorId))
      .orderBy(scheduleChangeRequest.createdAt);
    return Promise.all(requests.slice(-10).reverse().map(async (request) => ({
      ...request,
      affectedAppointments: await this.getScheduleRequest(doctorId, request.id).then((result) => result.affectedAppointments),
    })));
  }

  async approveScheduleRequest(doctorId: string, requestId: string) {
    const now = new Date();
    await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      const [request] = await tx.select().from(scheduleChangeRequest)
        .where(and(
          eq(scheduleChangeRequest.id, requestId),
          eq(scheduleChangeRequest.doctorId, doctorId),
        ))
        .for('update')
        .limit(1);
      if (!request) throw new NotFoundException('Schedule change request not found.');
      if (request.status !== 'pending') {
        throw new ConflictException(`Cannot approve a ${request.status} schedule change request.`);
      }
      if (request.expiresAt.getTime() <= now.getTime()) {
        const [expired] = await tx.update(scheduleChangeRequest)
          .set({ status: 'expired', expiredAt: now, updatedAt: now })
          .where(and(
            eq(scheduleChangeRequest.id, requestId),
            eq(scheduleChangeRequest.status, 'pending'),
          ))
          .returning();
        return expired;
      }
      if (request.approvedAt) return request;

      const affectedAppointments = await tx.select({
        id: scheduleChangeAppointment.id,
        consentStatus: scheduleChangeAppointment.consentStatus,
        resolutionStatus: scheduleChangeAppointment.resolutionStatus,
      })
        .from(scheduleChangeAppointment)
        .where(eq(scheduleChangeAppointment.requestId, requestId));
      const unresolvedAppointments = affectedAppointments.filter((item) =>
        item.consentStatus === 'pending' && item.resolutionStatus === 'pending');
      if (unresolvedAppointments.length > 0) {
        const alternatives = await tx.select({ affectedAppointmentId: scheduleChangeAlternative.affectedAppointmentId })
          .from(scheduleChangeAlternative)
          .where(inArray(
            scheduleChangeAlternative.affectedAppointmentId,
            unresolvedAppointments.map(({ id }) => id),
          ));
        const alternativeIds = new Set(alternatives.map(({ affectedAppointmentId }) => affectedAppointmentId));
        if (unresolvedAppointments.some(({ id }) => !alternativeIds.has(id))) {
          throw new ConflictException('Every affected appointment must have an alternative before approval.');
        }
      }

      const [approved] = await tx.update(scheduleChangeRequest)
        .set({ approvedAt: now, approvedBy: doctorId, updatedAt: now })
        .where(and(
          eq(scheduleChangeRequest.id, requestId),
          eq(scheduleChangeRequest.status, 'pending'),
        ))
        .returning();
      if (!approved) throw new ConflictException('Schedule change request changed concurrently.');

      if (this.notifications && unresolvedAppointments.length > 0) {
        const apptRecords = await tx.select({
          patientId: appointment.patientId,
          appointmentId: appointment.id,
        })
          .from(scheduleChangeAppointment)
          .innerJoin(appointment, eq(appointment.id, scheduleChangeAppointment.appointmentId))
          .where(and(
            eq(scheduleChangeAppointment.requestId, requestId),
            eq(scheduleChangeAppointment.consentStatus, 'pending'),
          ));
        const uniquePatients = [...new Map(apptRecords.map((a) => [a.patientId, a])).values()];
        await Promise.all(uniquePatients.map((item) => this.notifications!.createNotification({
          userId: item.patientId,
          title: 'Schedule change requires your response',
          message: 'Your doctor approved a schedule change proposal. Please review your alternative appointment times.',
          type: 'reschedule',
          appointmentId: item.appointmentId,
          scheduleRequestId: requestId,
        })));
      }

      return approved;
    });
    return this.finalizeScheduleRequest(doctorId, requestId);
  }

  async rejectScheduleRequest(doctorId: string, requestId: string, reason: string) {
    const now = new Date();
    return db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      const [request] = await tx.select().from(scheduleChangeRequest)
        .where(and(
          eq(scheduleChangeRequest.id, requestId),
          eq(scheduleChangeRequest.doctorId, doctorId),
        ))
        .for('update')
        .limit(1);
      if (!request) throw new NotFoundException('Schedule change request not found.');
      if (request.status === 'cancelled') return request;
      if (request.status !== 'pending' || request.approvedAt) {
        throw new ConflictException(`Cannot reject a ${request.status} schedule change request.`);
      }

      const affectedAppointments = await tx.select({
        consentStatus: scheduleChangeAppointment.consentStatus,
        resolutionStatus: scheduleChangeAppointment.resolutionStatus,
      }).from(scheduleChangeAppointment)
        .where(eq(scheduleChangeAppointment.requestId, requestId))
        .for('update');
      if (affectedAppointments.some((item) =>
        item.consentStatus !== 'pending' || item.resolutionStatus !== 'pending')) {
        throw new ConflictException('Cannot reject a request after an appointment resolution has begun.');
      }

      if (request.expiresAt.getTime() <= now.getTime()) {
        const [expired] = await tx.update(scheduleChangeRequest)
          .set({ status: 'expired', expiredAt: now, updatedAt: now })
          .where(and(
            eq(scheduleChangeRequest.id, requestId),
            eq(scheduleChangeRequest.status, 'pending'),
          ))
          .returning();
        return expired;
      }
      const [cancelled] = await tx.update(scheduleChangeRequest)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: doctorId,
          cancellationReason: reason,
          updatedAt: now,
        })
        .where(and(
          eq(scheduleChangeRequest.id, requestId),
          eq(scheduleChangeRequest.status, 'pending'),
        ))
        .returning();
      if (!cancelled) throw new ConflictException('Schedule change request changed concurrently.');
      return cancelled;
    });
  }

  async finalizeScheduleRequest(doctorId: string, requestId: string) {
    const now = new Date();
    return db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      const [request] = await tx.select().from(scheduleChangeRequest)
        .where(and(eq(scheduleChangeRequest.id, requestId), eq(scheduleChangeRequest.doctorId, doctorId)))
        .for('update').limit(1);
      if (!request) throw new NotFoundException('Schedule change request not found.');
      if (request.status !== 'pending' || !request.approvedAt) return request;
      if (request.expiresAt.getTime() <= now.getTime()) {
        const [expired] = await tx.update(scheduleChangeRequest).set({
          status: 'expired', expiredAt: now, updatedAt: now,
        }).where(and(eq(scheduleChangeRequest.id, requestId), eq(scheduleChangeRequest.status, 'pending'))).returning();
        return expired;
      }
      const affected = await tx.select({
        consentStatus: scheduleChangeAppointment.consentStatus,
        resolutionStatus: scheduleChangeAppointment.resolutionStatus,
      })
        .from(scheduleChangeAppointment).where(eq(scheduleChangeAppointment.requestId, requestId));
      if (affected.some((item) => item.resolutionStatus === 'pending' || item.consentStatus === 'pending')) return request;
      const proposed = doctorScheduleUpdateSchema.safeParse(request.proposedSchedule);
      if (!proposed.success) throw new ConflictException('The stored schedule proposal is invalid.');
      const conflicts = await this.findScheduleConflicts(tx, doctorId, proposed.data, now);
      if (conflicts.length > 0) {
        return {
          ...request,
          publicationBlocked: true,
          publicationBlockers: conflicts,
        };
      }
      const [published] = await tx.insert(doctorAvailability).values({
        id: randomUUID(),
        doctorId,
        timezone: proposed.data.timezone,
        activeDays: [...proposed.data.activeDays].sort((a, b) => a - b),
        startHour: proposed.data.startHour,
        endHour: proposed.data.endHour,
        slotDurationMinutes: proposed.data.slotDurationMinutes ?? 30,
        schedulingMode: proposed.data.schedulingMode,
        capacity: proposed.data.capacity,
        breakStart: proposed.data.breakStart ?? null,
        breakEnd: proposed.data.breakEnd ?? null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: doctorAvailability.doctorId,
        set: {
          timezone: proposed.data.timezone,
          activeDays: [...proposed.data.activeDays].sort((a, b) => a - b),
          startHour: proposed.data.startHour,
          endHour: proposed.data.endHour,
          slotDurationMinutes: proposed.data.slotDurationMinutes ?? 30,
          schedulingMode: proposed.data.schedulingMode,
          capacity: proposed.data.capacity,
          breakStart: proposed.data.breakStart ?? null,
          breakEnd: proposed.data.breakEnd ?? null,
          updatedAt: now,
        },
      }).returning();
      if (!published) throw new ConflictException('Doctor availability could not be published.');
      const [finalized] = await tx.update(scheduleChangeRequest).set({
        status: 'published', publishedAt: now, updatedAt: now,
      }).where(and(eq(scheduleChangeRequest.id, requestId), eq(scheduleChangeRequest.status, 'pending'))).returning();
      if (!finalized) throw new ConflictException('Schedule change request changed concurrently.');
      return finalized;
    });
  }

  private async findScheduleConflicts(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    doctorId: string,
    update: DoctorScheduleUpdate,
    now: Date,
  ): Promise<Array<{ id: string; patientId: string; startsAt: Date; endsAt: Date; status: 'scheduled' | 'pending_payment'; reason: string }>> {
    const supportingData = await this.getScheduleSupportingData(tx, doctorId);
    const { leaves, overrides } = supportingData;
    const appointments = await tx.select({
      id: appointment.id,
      patientId: appointment.patientId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
    }).from(appointment)
      .where(and(
        eq(appointment.doctorId, doctorId),
        gt(appointment.endsAt, now),
        or(
          eq(appointment.status, 'scheduled'),
          and(eq(appointment.status, 'pending_payment'), gt(appointment.holdExpiresAt, now)),
        ),
      ));

    const config = this.toScheduleConfig(update, leaves, overrides);

    const timeConflicts: Array<{ id: string; patientId: string; startsAt: Date; endsAt: Date; status: 'scheduled' | 'pending_payment'; reason: string }> = [];
    const compatibleAppointments: typeof appointments = [];

    for (const record of appointments) {
      if (isAppointmentCompatibleWithSchedule(record.startsAt, record.endsAt, now, config)) {
        compatibleAppointments.push(record);
      } else {
        timeConflicts.push({
          id: record.id,
          patientId: record.patientId,
          startsAt: record.startsAt,
          endsAt: record.endsAt,
          status: record.status as 'scheduled' | 'pending_payment',
          reason: record.status === 'pending_payment'
            ? 'Active payment hold falls outside the proposed schedule.'
            : 'Booked appointment falls outside the proposed schedule.',
        });
      }
    }

    const capacityConflicts = findCapacityConflicts(compatibleAppointments, now, config).map((conflict) => ({
      id: conflict.id,
      patientId: conflict.patientId,
      startsAt: conflict.startsAt,
      endsAt: conflict.endsAt,
      status: conflict.status as 'scheduled' | 'pending_payment',
      reason: conflict.status === 'pending_payment'
        ? 'Active payment hold exceeds proposed session capacity.'
        : 'Booked appointment exceeds proposed session capacity.',
    }));

    return [...timeConflicts, ...capacityConflicts];
  }

  private async getScheduleSupportingData(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    doctorId: string,
  ) {
    const leaves = await tx.select({ date: doctorLeave.date }).from(doctorLeave)
      .where(eq(doctorLeave.doctorId, doctorId));
    const overrides = await tx.select({
      date: doctorScheduleOverride.date,
      startHour: doctorScheduleOverride.startHour,
      endHour: doctorScheduleOverride.endHour,
      slotDurationMinutes: doctorScheduleOverride.slotDurationMinutes,
      schedulingMode: doctorScheduleOverride.schedulingMode,
      capacity: doctorScheduleOverride.capacity,
      breakStart: doctorScheduleOverride.breakStart,
      breakEnd: doctorScheduleOverride.breakEnd,
    }).from(doctorScheduleOverride)
      .where(eq(doctorScheduleOverride.doctorId, doctorId));
    return { leaves, overrides };
  }

  private toScheduleConfig(
    update: DoctorScheduleUpdate,
    leaves: Array<{ date: string }>,
    overrides: Array<{
      date: string;
      startHour: number;
      endHour: number;
      slotDurationMinutes: number;
      schedulingMode: string | null;
      capacity: number | null;
      breakStart: string | null;
      breakEnd: string | null;
    }>,
  ): DoctorScheduleConfig {
    return {
      timezone: update.timezone,
      activeDays: update.activeDays,
      startHour: update.startHour,
      endHour: update.endHour,
      slotDurationMinutes: update.slotDurationMinutes,
      schedulingMode: update.schedulingMode,
      capacity: update.capacity,
      breakStart: update.breakStart ?? null,
      breakEnd: update.breakEnd ?? null,
      leaveDates: leaves.map(({ date }) => date),
      dateOverrides: overrides.map((override) => ({
        date: override.date,
        startHour: override.startHour,
        endHour: override.endHour,
        slotDurationMinutes: override.slotDurationMinutes,
        schedulingMode: override.schedulingMode as 'wave' | 'stream' | null,
        capacity: override.capacity,
        breakStart: override.breakStart,
        breakEnd: override.breakEnd,
      })),
    };
  }

  private async generateAlternatives(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    doctorId: string,
    affectedAppointmentId: string,
    originalStartsAt: Date,
    originalEndsAt: Date,
    config: DoctorScheduleConfig,
    now: Date,
  ) {
    const occupied = await tx.select({
      id: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      holdExpiresAt: appointment.holdExpiresAt,
    }).from(appointment)
      .where(and(
        eq(appointment.doctorId, doctorId),
        ne(appointment.id, affectedAppointmentId),
        gte(appointment.startsAt, now),
        or(
          eq(appointment.status, 'scheduled'),
          and(eq(appointment.status, 'pending_payment'), gt(appointment.holdExpiresAt, now)),
        ),
      ));

    const timezone = config.timezone ?? DEFAULT_SCHEDULE.timezone;
    const originalDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(originalStartsAt);
    const targetDuration = originalEndsAt.getTime() - originalStartsAt.getTime();
    const alternatives = [];
    for (let offset = 0; offset < ALTERNATIVE_SEARCH_DAYS; offset++) {
      const date = this.addCalendarDays(originalDate, offset);
      const slots = getAvailableSlotsWithCapacity(date, occupied, now, config)
        .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
      for (const slot of slots) {
        const slotDuration = slot.endsAt.getTime() - slot.startsAt.getTime();
        if (slotDuration === targetDuration && isBookableSlot(slot.startsAt, slot.endsAt, now, config)) {
          alternatives.push({ startsAt: slot.startsAt, endsAt: slot.endsAt });
          continue;
        }
        if (slot.mode !== 'wave' || slotDuration !== 30 * 60_000 || targetDuration !== 15 * 60_000) continue;
        for (const startsAt of [slot.startsAt, new Date(slot.startsAt.getTime() + 15 * 60_000)]) {
          const endsAt = new Date(startsAt.getTime() + targetDuration);
          if (startsAt.getTime() === originalStartsAt.getTime() && endsAt.getTime() === originalEndsAt.getTime()) continue;
          if (getBookableRescheduleWindow(startsAt, endsAt, now, config)) alternatives.push({ startsAt, endsAt });
        }
      }
    }

    return alternatives
      .sort((left, right) => {
        const leftDistance = Math.abs(left.startsAt.getTime() - originalStartsAt.getTime());
        const rightDistance = Math.abs(right.startsAt.getTime() - originalStartsAt.getTime());
        return leftDistance - rightDistance || left.startsAt.getTime() - right.startsAt.getTime();
      })
      .filter((slot, index, all) =>
        all.findIndex((candidate) =>
          candidate.startsAt.getTime() === slot.startsAt.getTime() &&
          candidate.endsAt.getTime() === slot.endsAt.getTime()) === index)
      .slice(0, MAX_ALTERNATIVES_PER_APPOINTMENT);
  }

  private addCalendarDays(date: string, days: number): string {
    const value = new Date(`${date}T12:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  async addLeave(doctorId: string, input: DoctorLeaveInput): Promise<DoctorLeaveRecord> {
    const now = new Date();
    const [saved] = await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      return tx.insert(doctorLeave).values({
        id: randomUUID(), doctorId, date: input.date, reason: input.reason ?? null, createdAt: now,
      }).onConflictDoUpdate({
        target: [doctorLeave.doctorId, doctorLeave.date],
        set: { reason: input.reason ?? null },
      }).returning();
    });
    return {
      id: saved.id,
      date: saved.date,
      ...(saved.reason ? { reason: saved.reason } : {}),
      createdAt: saved.createdAt.toISOString(),
    };
  }

  async removeLeave(doctorId: string, leaveId: string): Promise<void> {
    const [deleted] = await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      return tx.delete(doctorLeave).where(and(
        eq(doctorLeave.doctorId, doctorId),
        or(eq(doctorLeave.id, leaveId), eq(doctorLeave.date, leaveId)),
      )).returning({ id: doctorLeave.id });
    });
    if (!deleted) throw new NotFoundException('Leave record not found.');
  }

  async upsertOverride(doctorId: string, input: DoctorScheduleOverrideInput): Promise<DoctorScheduleOverrideRecord> {
    const now = new Date();
    const values = {
      startHour: input.startHour,
      endHour: input.endHour,
      slotDurationMinutes: input.slotDurationMinutes ?? 30,
      schedulingMode: input.schedulingMode ?? null,
      capacity: input.capacity ?? null,
      breakStart: input.breakStart ?? null,
      breakEnd: input.breakEnd ?? null,
      updatedAt: now,
    };
    const [saved] = await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      return tx.insert(doctorScheduleOverride).values({
        id: randomUUID(), doctorId, date: input.date, ...values, createdAt: now,
      }).onConflictDoUpdate({
        target: [doctorScheduleOverride.doctorId, doctorScheduleOverride.date],
        set: values,
      }).returning();
    });
    return {
      id: saved.id,
      date: saved.date,
      startHour: saved.startHour,
      endHour: saved.endHour,
      slotDurationMinutes: saved.slotDurationMinutes,
      schedulingMode: saved.schedulingMode as 'wave' | 'stream' | null,
      capacity: saved.capacity,
      breakStart: saved.breakStart,
      breakEnd: saved.breakEnd,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  async removeOverride(doctorId: string, date: string): Promise<void> {
    const [deleted] = await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      return tx.delete(doctorScheduleOverride).where(and(
        eq(doctorScheduleOverride.doctorId, doctorId), eq(doctorScheduleOverride.date, date),
      )).returning({ id: doctorScheduleOverride.id });
    });
    if (!deleted) throw new NotFoundException('Schedule override not found.');
  }

  async checkConflicts(doctorId: string, newConfig: DoctorScheduleUpdate) {
    const now = new Date();
    return db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      const conflicts = await this.findScheduleConflicts(tx, doctorId, newConfig, now);
      return {
        hasConflicts: conflicts.length > 0,
        conflictCount: conflicts.length,
        conflicts,
      };
    });
  }

  async getScheduleConfigForProfile(doctorProfileId: string): Promise<DoctorScheduleConfig> {
    const [doc] = await db.select({ userId: doctorProfile.userId })
      .from(doctorProfile).where(eq(doctorProfile.id, doctorProfileId)).limit(1);
    if (!doc) return {};
    return this.getScheduleConfigForDoctor(doc.userId);
  }

  async getScheduleConfigForDoctor(doctorId: string): Promise<DoctorScheduleConfig> {
    const schedule = await this.getSchedule(doctorId);
    return {
      timezone: schedule.timezone,
      activeDays: schedule.activeDays,
      startHour: schedule.startHour,
      endHour: schedule.endHour,
      slotDurationMinutes: schedule.slotDurationMinutes,
      schedulingMode: schedule.schedulingMode,
      capacity: schedule.capacity,
      breakStart: schedule.breakStart,
      breakEnd: schedule.breakEnd,
      leaveDates: schedule.leaves.map((leave) => leave.date),
      dateOverrides: schedule.overrides,
    };
  }
}
