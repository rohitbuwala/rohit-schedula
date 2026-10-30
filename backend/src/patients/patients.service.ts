import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/database.js';
import { user } from '../db/schema.js';
import type { PatientProfileUpdate } from './patient-profile.schema.js';

@Injectable()
export class PatientsService {
  async getOwn(patientId: string) {
    const [profile] = await db.select({ id: user.id, name: user.name, email: user.email, image: user.image })
      .from(user).where(and(eq(user.id, patientId), eq(user.role, 'patient'))).limit(1);
    if (!profile) throw new NotFoundException('Patient profile not found.');
    return profile;
  }

  async updateOwn(patientId: string, input: PatientProfileUpdate) {
    const [profile] = await db.update(user).set({ ...input, updatedAt: new Date() })
      .where(and(eq(user.id, patientId), eq(user.role, 'patient')))
      .returning({ id: user.id, name: user.name, email: user.email, image: user.image });
    if (!profile) throw new NotFoundException('Patient profile not found.');
    return profile;
  }
}
