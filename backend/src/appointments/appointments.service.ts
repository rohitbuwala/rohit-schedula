import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { AuthenticatedUser, UserRole } from '../auth/authenticated-user.js';
import { db } from '../db/database.js';
import { appointment, doctorProfile, user } from '../db/schema.js';
import { DoctorProfilesService } from '../doctors/doctor-profiles.service.js';
import { DoctorScheduleService } from '../doctors/doctor-schedule.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { canAccessAppointment } from './appointment-access.js';
import { createWithConflictHandling } from './appointment-conflict.js';
import { createZonedDate, getAvailableSlots, isBookableSlot } from './appointment-availability.js';
import type { AppointmentAvailabilityQuery } from './appointment-availability.schema.js';
import type { z } from 'zod';
import type { appointmentBookingSchema } from './appointment-booking.schema.js';
import type { AppointmentRescheduleInput } from './appointment-reschedule.schema.js';
import { randomUUID } from 'node:crypto';

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly doctors: DoctorProfilesService,
    @Optional() private readonly scheduleService?: DoctorScheduleService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  async getAvailableSlots(patientId: string, input: AppointmentAvailabilityQuery) {
    const doctor = await this.findApprovedDoctor(input.doctorProfileId);
    if (!doctor) throw new NotFoundException('Approved doctor not found.');
    if (doctor.userId === patientId) throw new ForbiddenException();

    const scheduleConfig = this.scheduleService
      ? await this.scheduleService.getScheduleConfigForProfile(input.doctorProfileId)
      : { timezone: 'Asia/Kolkata', slotDurationMinutes: 30 };

    const tz = scheduleConfig.timezone ?? 'Asia/Kolkata';
    const dayStart = createZonedDate(input.date, 0, 0, tz);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const busy = await db.select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status })
      .from(appointment)
      .where(and(eq(appointment.doctorId, doctor.userId), eq(appointment.status, 'scheduled'), lt(appointment.startsAt, dayEnd), gt(appointment.endsAt, dayStart)));

    const slots = getAvailableSlots(input.date, busy, new Date(), {
      ...scheduleConfig,
      timezone: tz,
    });

    return {
      doctorProfileId: input.doctorProfileId,
      date: input.date,
      timezone: tz,
      durationMinutes: scheduleConfig.slotDurationMinutes ?? 30,
      slots: slots.map(({ startsAt, endsAt }) => ({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() })),
    };
  }

  async createForPatient(patientId: string, input: z.infer<typeof appointmentBookingSchema>) {
    const doctor = await this.findApprovedDoctor(input.doctorProfileId);
    if (!doctor) throw new NotFoundException('Approved doctor not found.');
    if (doctor.userId === patientId) throw new ForbiddenException();

    const scheduleConfig = this.scheduleService
      ? await this.scheduleService.getScheduleConfigForProfile(input.doctorProfileId)
      : { timezone: 'Asia/Kolkata', slotDurationMinutes: 30 };
    const tz = scheduleConfig.timezone ?? 'Asia/Kolkata';

    if (!isBookableSlot(input.startsAt, input.endsAt, new Date(), { ...scheduleConfig, timezone: tz })) {
      throw new BadRequestException('The selected slot is not within the doctor’s available schedule.');
    }

    const busy = await db.select({ id: appointment.id })
      .from(appointment)
      .where(and(
        eq(appointment.doctorId, doctor.userId),
        eq(appointment.status, 'scheduled'),
        lt(appointment.startsAt, input.endsAt),
        gt(appointment.endsAt, input.startsAt),
      ))
      .limit(1);

    if (busy.length > 0) {
      throw new ConflictException('The selected doctor already has a scheduled appointment in that time slot.');
    }

    return createWithConflictHandling(async () => {
      const [created] = await db.insert(appointment).values({
        id: randomUUID(),
        patientId,
        doctorId: doctor.userId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      }).returning({
        id: appointment.id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
      });

      if (this.notifications) {
        const timeFormatted = new Intl.DateTimeFormat('en-IN', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Kolkata',
        }).format(input.startsAt);

        void this.notifications.createNotification({
          userId: patientId,
          title: 'Appointment Booked',
          message: `Consultation confirmed for ${timeFormatted} IST.`,
          type: 'booking',
          appointmentId: created.id,
        });

        void this.notifications.createNotification({
          userId: doctor.userId,
          title: 'New Patient Appointment',
          message: `A new consultation has been scheduled for ${timeFormatted} IST.`,
          type: 'booking',
          appointmentId: created.id,
        });
      }

      return created;
    });
  }

  async listMine(actor: AuthenticatedUser) {
    await this.assertDoctorApproved(actor.role, actor.id);
    if (actor.role === 'patient') {
      return db.select({
        id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status,
        doctor: { id: doctorProfile.id, name: user.name, specialty: doctorProfile.specialty, bio: doctorProfile.bio },
      }).from(appointment)
        .innerJoin(user, eq(user.id, appointment.doctorId))
        .innerJoin(doctorProfile, eq(doctorProfile.userId, user.id))
        .where(eq(appointment.patientId, actor.id));
    }
    if (actor.role === 'doctor') {
      return db.select({
        id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status,
        patient: { id: user.id, name: user.name },
      }).from(appointment).innerJoin(user, and(eq(user.id, appointment.patientId), eq(user.role, 'patient')))
        .where(eq(appointment.doctorId, actor.id));
    }
    throw new ForbiddenException();
  }

  async getMine(id: string, actor: AuthenticatedUser) {
    await this.assertDoctorApproved(actor.role, actor.id);
    const [participants] = await db.select({ id: appointment.id, patientId: appointment.patientId, doctorId: appointment.doctorId })
      .from(appointment).where(eq(appointment.id, id)).limit(1);
    if (!participants || !canAccessAppointment(actor.role, actor.id, participants)) throw new NotFoundException('Appointment not found.');

    if (actor.role === 'patient') {
      const [record] = await db.select({
        id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status,
        doctor: { id: doctorProfile.id, name: user.name, specialty: doctorProfile.specialty, bio: doctorProfile.bio },
      }).from(appointment).innerJoin(user, eq(user.id, appointment.doctorId))
        .innerJoin(doctorProfile, eq(doctorProfile.userId, user.id))
        .where(and(eq(appointment.id, id), eq(appointment.patientId, actor.id))).limit(1);
      if (!record) throw new NotFoundException('Appointment not found.');
      return record;
    }
    if (actor.role === 'doctor') {
      const [record] = await db.select({
        id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status,
        patient: { id: user.id, name: user.name },
      }).from(appointment).innerJoin(user, and(eq(user.id, appointment.patientId), eq(user.role, 'patient')))
        .where(and(eq(appointment.id, id), eq(appointment.doctorId, actor.id))).limit(1);
      if (!record) throw new NotFoundException('Appointment not found.');
      return record;
    }
    throw new NotFoundException('Appointment not found.');
  }

  async getPatientForDoctorAppointment(id: string, doctorId: string) {
    await this.assertDoctorApproved('doctor', doctorId);
    const [patient] = await db.select({ id: user.id, name: user.name }).from(appointment)
      .innerJoin(user, and(eq(user.id, appointment.patientId), eq(user.role, 'patient')))
      .where(and(eq(appointment.id, id), eq(appointment.doctorId, doctorId))).limit(1);
    if (!patient) throw new NotFoundException('Appointment not found.');
    return patient;
  }

  async reschedule(id: string, actor: AuthenticatedUser, input: AppointmentRescheduleInput) {
    if (actor.role === 'doctor') {
      await this.assertDoctorApproved(actor.role, actor.id);
    } else if (actor.role !== 'patient') {
      throw new ForbiddenException();
    }

    return db.transaction(async (tx) => {
      const [record] = await tx.select().from(appointment)
        .where(eq(appointment.id, id))
        .for('update')
        .limit(1);

      if (!record || !canAccessAppointment(actor.role, actor.id, record)) {
        throw new NotFoundException('Appointment not found.');
      }

      if (record.status !== 'scheduled') {
        throw new ConflictException(`Cannot reschedule an appointment that is already ${record.status}.`);
      }

      const isDoctorApproved = await this.doctors.isApproved(record.doctorId);
      if (!isDoctorApproved) {
        throw new ConflictException('Cannot reschedule appointment because doctor is currently inactive or unapproved.');
      }

      if (
        record.startsAt.getTime() === input.startsAt.getTime() &&
        record.endsAt.getTime() === input.endsAt.getTime()
      ) {
        return record;
      }

      const durationMs = input.endsAt.getTime() - input.startsAt.getTime();
      const originalDurationMs = record.endsAt.getTime() - record.startsAt.getTime();
      if (
        durationMs !== originalDurationMs &&
        durationMs !== 15 * 60 * 1000 &&
        durationMs !== 30 * 60 * 1000
      ) {
        throw new BadRequestException('Appointment duration must be 15 or 30 minutes.');
      }

      try {
        const [updated] = await tx.update(appointment)
          .set({
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            updatedAt: new Date(),
          })
          .where(and(eq(appointment.id, id), eq(appointment.status, 'scheduled')))
          .returning({
            id: appointment.id,
            patientId: appointment.patientId,
            doctorId: appointment.doctorId,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            status: appointment.status,
            updatedAt: appointment.updatedAt,
          });

        if (!updated) {
          throw new ConflictException('Appointment changed concurrently; please refresh.');
        }

        if (this.notifications) {
          const timeFormatted = new Intl.DateTimeFormat('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Asia/Kolkata',
          }).format(input.startsAt);

          void this.notifications.createNotification({
            userId: record.patientId,
            title: 'Appointment Rescheduled',
            message: `Your appointment has been rescheduled to ${timeFormatted} IST.`,
            type: 'reschedule',
            appointmentId: id,
          });

          void this.notifications.createNotification({
            userId: record.doctorId,
            title: 'Appointment Rescheduled',
            message: `Consultation rescheduled to ${timeFormatted} IST.`,
            type: 'reschedule',
            appointmentId: id,
          });
        }

        return updated;
      } catch (err: unknown) {
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23P01') {
          throw new ConflictException('The selected doctor already has a scheduled appointment in that time slot.');
        }
        throw err;
      }
    });
  }

  async cancel(id: string, actor: AuthenticatedUser) {
    if (actor.role === 'doctor') {
      await this.assertDoctorApproved(actor.role, actor.id);
    } else if (actor.role !== 'patient') {
      throw new ForbiddenException();
    }

    return db.transaction(async (tx) => {
      const [record] = await tx.select().from(appointment)
        .where(eq(appointment.id, id))
        .for('update')
        .limit(1);

      if (!record || !canAccessAppointment(actor.role, actor.id, record)) {
        throw new NotFoundException('Appointment not found.');
      }

      if (record.status !== 'scheduled') {
        throw new ConflictException(`Cannot cancel an appointment that is already ${record.status}.`);
      }

      const [updated] = await tx.update(appointment)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(appointment.id, id), eq(appointment.status, 'scheduled')))
        .returning({ id: appointment.id, status: appointment.status, updatedAt: appointment.updatedAt });

      if (!updated) {
        throw new ConflictException('Appointment changed concurrently; please refresh.');
      }

      if (this.notifications) {
        void this.notifications.createNotification({
          userId: record.patientId,
          title: 'Appointment Cancelled',
          message: 'Appointment was cancelled and the time slot was released.',
          type: 'cancellation',
          appointmentId: id,
        });

        void this.notifications.createNotification({
          userId: record.doctorId,
          title: 'Appointment Cancelled',
          message: 'A patient consultation was cancelled and the slot was released.',
          type: 'cancellation',
          appointmentId: id,
        });
      }

      return updated;
    });
  }

  async complete(id: string, actor: AuthenticatedUser) {
    if (actor.role !== 'doctor') {
      throw new ForbiddenException('Only doctors can complete appointments.');
    }
    await this.assertDoctorApproved(actor.role, actor.id);

    return db.transaction(async (tx) => {
      const [record] = await tx.select().from(appointment)
        .where(eq(appointment.id, id))
        .for('update')
        .limit(1);

      if (!record || record.doctorId !== actor.id) {
        throw new NotFoundException('Appointment not found.');
      }

      if (record.status !== 'scheduled') {
        throw new ConflictException(`Cannot complete an appointment that is ${record.status}.`);
      }

      const [updated] = await tx.update(appointment)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(and(eq(appointment.id, id), eq(appointment.status, 'scheduled')))
        .returning({ id: appointment.id, status: appointment.status, updatedAt: appointment.updatedAt });

      if (!updated) {
        throw new ConflictException('Appointment changed concurrently; please refresh.');
      }

      if (this.notifications) {
        void this.notifications.createNotification({
          userId: record.patientId,
          title: 'Consultation Completed',
          message: 'Your consultation has concluded. We hope you had a great care experience.',
          type: 'completion',
          appointmentId: id,
        });
      }

      return updated;
    });
  }

  private async assertDoctorApproved(role: UserRole, userId: string): Promise<void> {
    if (role === 'doctor' && !(await this.doctors.isApproved(userId))) throw new ForbiddenException();
  }

  private async findApprovedDoctor(profileId: string) {
    const [doctor] = await db.select({ userId: doctorProfile.userId }).from(doctorProfile)
      .innerJoin(user, eq(user.id, doctorProfile.userId))
      .where(and(eq(doctorProfile.id, profileId), eq(doctorProfile.status, 'approved'), eq(user.role, 'doctor')))
      .limit(1);
    return doctor;
  }
}
