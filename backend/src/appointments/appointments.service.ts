import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { AuthenticatedUser, UserRole } from '../auth/authenticated-user.js';
import { db } from '../db/database.js';
import { appointment, doctorProfile, user } from '../db/schema.js';
import { DoctorProfilesService } from '../doctors/doctor-profiles.service.js';
import { canAccessAppointment } from './appointment-access.js';
import { createWithConflictHandling } from './appointment-conflict.js';
import { getAvailableSlots } from './appointment-availability.js';
import type { AppointmentAvailabilityQuery } from './appointment-availability.schema.js';
import type { z } from 'zod';
import type { appointmentBookingSchema } from './appointment-booking.schema.js';
import { randomUUID } from 'node:crypto';

@Injectable()
export class AppointmentsService {
  constructor(private readonly doctors: DoctorProfilesService) {}

  async getAvailableSlots(patientId: string, input: AppointmentAvailabilityQuery) {
    const doctor = await this.findApprovedDoctor(input.doctorProfileId);
    if (!doctor) throw new NotFoundException('Approved doctor not found.');
    if (doctor.userId === patientId) throw new ForbiddenException();

    const dayStart = new Date(`${input.date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const busy = await db.select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status })
      .from(appointment)
      .where(and(eq(appointment.doctorId, doctor.userId), eq(appointment.status, 'scheduled'), lt(appointment.startsAt, dayEnd), gt(appointment.endsAt, dayStart)));
    return {
      doctorProfileId: input.doctorProfileId,
      date: input.date,
      timezone: 'UTC',
      durationMinutes: 30,
      slots: getAvailableSlots(input.date, busy).map(({ startsAt, endsAt }) => ({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() })),
    };
  }

  async createForPatient(patientId: string, input: z.infer<typeof appointmentBookingSchema>) {
    const doctor = await this.findApprovedDoctor(input.doctorProfileId);
    if (!doctor) throw new NotFoundException('Approved doctor not found.');
    if (doctor.userId === patientId) throw new ForbiddenException();

    return createWithConflictHandling(async () => {
      const [created] = await db.insert(appointment).values({
        id: randomUUID(), patientId, doctorId: doctor.userId,
        startsAt: input.startsAt, endsAt: input.endsAt,
      }).returning({ id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status });
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
        .innerJoin(doctorProfile, and(eq(doctorProfile.userId, user.id), eq(doctorProfile.status, 'approved')))
        .where(and(eq(appointment.patientId, actor.id), eq(user.role, 'doctor')));
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
        .innerJoin(doctorProfile, and(eq(doctorProfile.userId, user.id), eq(doctorProfile.status, 'approved')))
        .where(and(eq(appointment.id, id), eq(appointment.patientId, actor.id), eq(user.role, 'doctor'))).limit(1);
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
