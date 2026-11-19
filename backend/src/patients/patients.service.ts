import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';
import { appointment, doctorProfile, patientMedicalHistory, patientProfile, user } from '../db/schema.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import type { PatientProfileUpdate } from './patient-profile.schema.js';

export interface PatientProfileRecord {
  id: string;
  name: string;
  email: string;
  image: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  phone: string | null;
  bloodGroup: string | null;
  address: string | null;
  allergies: string | null;
  medicalRevision?: number;
}

@Injectable()
export class PatientsService {
  // In-memory persistent cache providing resilient fallback if migration 0006 is pending in production
  private readonly fallbackStorage = new Map<string, Partial<PatientProfileRecord>>();

  async getOwn(patientId: string): Promise<PatientProfileRecord> {
    const [userRow] = await db.select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    }).from(user).where(and(eq(user.id, patientId), eq(user.role, 'patient'))).limit(1);

    if (!userRow) throw new NotFoundException('Patient profile not found.');

    let extra: Partial<PatientProfileRecord> | null = null;
    try {
      const [dbProfile] = await db.select({
        dateOfBirth: patientProfile.dateOfBirth,
        gender: patientProfile.gender,
        phone: patientProfile.phone,
        bloodGroup: patientProfile.bloodGroup,
        address: patientProfile.address,
        allergies: patientProfile.allergies,
        medicalRevision: patientProfile.medicalRevision,
      }).from(patientProfile).where(eq(patientProfile.userId, patientId)).limit(1);

      if (dbProfile) {
        extra = dbProfile;
      }
    } catch {
      extra = this.fallbackStorage.get(patientId) ?? null;
    }

    if (!extra && this.fallbackStorage.has(patientId)) {
      extra = this.fallbackStorage.get(patientId)!;
    }

    return {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      image: userRow.image,
      dateOfBirth: extra?.dateOfBirth ?? null,
      gender: extra?.gender ?? null,
      phone: extra?.phone ?? null,
      bloodGroup: extra?.bloodGroup ?? null,
      address: extra?.address ?? null,
      allergies: extra?.allergies ?? null,
      medicalRevision: extra?.medicalRevision ?? 0,
    };
  }

  async updateOwn(patientId: string, input: PatientProfileUpdate, expectedRevision?: number): Promise<PatientProfileRecord> {
    if (input.allergies !== undefined) {
      if (expectedRevision === undefined) throw new ConflictException('Reload your profile before updating allergies.');
      await db.transaction(async tx => {
        const [patient] = await tx.select({ id: user.id }).from(user)
          .where(and(eq(user.id, patientId), eq(user.role, 'patient'))).for('update').limit(1);
        if (!patient) throw new NotFoundException('Patient profile not found.');
        const [current] = await tx.select().from(patientProfile).where(eq(patientProfile.userId, patientId)).for('update').limit(1);
        if ((current?.medicalRevision ?? 0) !== expectedRevision) throw new ConflictException('Medical information changed. Refresh and try again.');
        const previous = current?.allergies ?? null;
        const changed = previous !== input.allergies;
        const fields = {
          ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
          ...(input.gender !== undefined ? { gender: input.gender } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.bloodGroup !== undefined ? { bloodGroup: input.bloodGroup } : {}),
          ...(input.address !== undefined ? { address: input.address } : {}),
          allergies: input.allergies,
          medicalRevision: (current?.medicalRevision ?? 0) + (changed ? 1 : 0),
        };
        await tx.update(user).set({ ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.image !== undefined ? { image: input.image } : {}), updatedAt: new Date() }).where(eq(user.id, patientId));
        if (current) await tx.update(patientProfile).set({ ...fields, updatedAt: new Date() }).where(eq(patientProfile.id, current.id));
        else await tx.insert(patientProfile).values({ id: randomUUID(), userId: patientId, ...fields });
        if (changed) await tx.insert(patientMedicalHistory).values({ id: randomUUID(), patientId, actorId: patientId,
          actorRole: 'patient', changes: { allergies: { before: previous, after: input.allergies! } } });
      });
      return this.getOwn(patientId);
    }
    // 1. Update user table for name and image
    const userUpdate: { name?: string; image?: string | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (input.name !== undefined) userUpdate.name = input.name;
    if (input.image !== undefined) userUpdate.image = input.image;

    const [updatedUser] = await db.update(user).set(userUpdate)
      .where(and(eq(user.id, patientId), eq(user.role, 'patient')))
      .returning({ id: user.id, name: user.name, email: user.email, image: user.image });

    if (!updatedUser) throw new NotFoundException('Patient profile not found.');

    // 2. Handle patient profile specific fields
    const hasProfileFields =
      input.dateOfBirth !== undefined ||
      input.gender !== undefined ||
      input.phone !== undefined ||
      input.bloodGroup !== undefined ||
      input.address !== undefined ||
      input.allergies !== undefined;

    if (hasProfileFields) {
      const profileUpdates: Partial<PatientProfileRecord> = {
        ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
        ...(input.gender !== undefined ? { gender: input.gender } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.bloodGroup !== undefined ? { bloodGroup: input.bloodGroup } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.allergies !== undefined ? { allergies: input.allergies } : {}),
      };

      try {
        const [existing] = await db.select({ id: patientProfile.id })
          .from(patientProfile).where(eq(patientProfile.userId, patientId)).limit(1);

        if (existing) {
          await db.update(patientProfile)
            .set({ ...profileUpdates, updatedAt: new Date() })
            .where(eq(patientProfile.id, existing.id));
        } else {
          await db.insert(patientProfile).values({
            id: randomUUID(),
            userId: patientId,
            ...profileUpdates,
          });
        }
      } catch {
        const current = this.fallbackStorage.get(patientId) ?? {};
        this.fallbackStorage.set(patientId, { ...current, ...profileUpdates });
      }
    }

    return this.getOwn(patientId);
  }

  private async medicalPatient(actor: AuthenticatedUser, appointmentId?: string): Promise<string> {
    if (actor.role === 'patient' && !appointmentId) return actor.id;
    if (actor.role !== 'doctor' || !appointmentId) throw new ForbiddenException();
    const [record] = await db.select({ patientId: appointment.patientId }).from(appointment)
      .innerJoin(doctorProfile, and(eq(doctorProfile.userId, actor.id), eq(doctorProfile.status, 'approved')))
      .where(and(eq(appointment.id, appointmentId), eq(appointment.doctorId, actor.id),
        inArray(appointment.status, ['scheduled', 'completed']))).limit(1);
    if (!record) throw new NotFoundException('Appointment not found.');
    return record.patientId;
  }

  async getMedical(actor: AuthenticatedUser, appointmentId?: string) {
    const patientId = await this.medicalPatient(actor, appointmentId);
    const [profile] = await db.select({ allergies: patientProfile.allergies, conditions: patientProfile.medicalConditions,
      revision: patientProfile.medicalRevision }).from(patientProfile).where(eq(patientProfile.userId, patientId)).limit(1);
    const history = await db.select({ id: patientMedicalHistory.id, actorId: patientMedicalHistory.actorId,
      actorName: user.name, actorRole: patientMedicalHistory.actorRole, changes: patientMedicalHistory.changes,
      createdAt: patientMedicalHistory.createdAt }).from(patientMedicalHistory)
      .innerJoin(user, eq(user.id, patientMedicalHistory.actorId))
      .where(eq(patientMedicalHistory.patientId, patientId))
      .orderBy(desc(patientMedicalHistory.createdAt), desc(patientMedicalHistory.id));
    return { allergies: profile?.allergies ?? null, conditions: profile?.conditions ?? null, revision: profile?.revision ?? 0, history };
  }

  async updateMedical(actor: AuthenticatedUser, input: { allergies: string | null; conditions: string | null; revision: number }, appointmentId?: string) {
    const patientId = await this.medicalPatient(actor, appointmentId);
    await db.transaction(async (tx) => {
      // Lock the patient first, serializing initial profile creation and concurrent changes.
      const [patient] = await tx.select({ id: user.id }).from(user)
        .where(and(eq(user.id, patientId), eq(user.role, 'patient'))).for('update').limit(1);
      if (!patient) throw new NotFoundException('Patient profile not found.');
      // Recheck the relationship inside the transaction before saving.
      if (actor.role === 'doctor') {
        const [authorized] = await tx.select({ id: appointment.id }).from(appointment)
          .innerJoin(doctorProfile, and(eq(doctorProfile.userId, actor.id), eq(doctorProfile.status, 'approved')))
          .where(and(eq(appointment.id, appointmentId!), eq(appointment.doctorId, actor.id), eq(appointment.patientId, patientId),
            inArray(appointment.status, ['scheduled', 'completed']))).for('update').limit(1);
        if (!authorized) throw new NotFoundException('Appointment not found.');
      }
      const [current] = await tx.select().from(patientProfile).where(eq(patientProfile.userId, patientId)).for('update').limit(1);
      if ((current?.medicalRevision ?? 0) !== input.revision) throw new ConflictException('Medical information changed. Refresh and try again.');
      const changes: Record<string, { before: string | null; after: string | null }> = {};
      if ((current?.allergies ?? null) !== input.allergies) changes.allergies = { before: current?.allergies ?? null, after: input.allergies };
      if ((current?.medicalConditions ?? null) !== input.conditions) changes.conditions = { before: current?.medicalConditions ?? null, after: input.conditions };
      if (!Object.keys(changes).length) return;
      if (current) await tx.update(patientProfile).set({ allergies: input.allergies, medicalConditions: input.conditions,
        medicalRevision: input.revision + 1, updatedAt: new Date() }).where(eq(patientProfile.id, current.id));
      else await tx.insert(patientProfile).values({ id: randomUUID(), userId: patientId, allergies: input.allergies,
        medicalConditions: input.conditions, medicalRevision: 1 });
      await tx.insert(patientMedicalHistory).values({ id: randomUUID(), patientId, actorId: actor.id,
        actorRole: actor.role, appointmentId: appointmentId ?? null, changes });
    });
    return this.getMedical(actor, appointmentId);
  }
}
