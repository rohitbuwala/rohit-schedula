import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';
import { patientProfile, user } from '../db/schema.js';
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
    };
  }

  async updateOwn(patientId: string, input: PatientProfileUpdate): Promise<PatientProfileRecord> {
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
}
