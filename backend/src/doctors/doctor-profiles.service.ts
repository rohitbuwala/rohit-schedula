import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';
import { doctorProfile, user } from '../db/schema.js';
import { toPublicDoctorProfile, type DoctorApplicationInput } from './doctor-profile.schema.js';

@Injectable()
export class DoctorProfilesService {
  async isApproved(userId: string): Promise<boolean> {
    const rows = await db.select({ userId: doctorProfile.userId }).from(doctorProfile)
      .where(and(eq(doctorProfile.userId, userId), eq(doctorProfile.status, 'approved'))).limit(1);
    return rows.length === 1;
  }

  async apply(userId: string, input: DoctorApplicationInput) {
    const [existing] = await db.select().from(doctorProfile).where(eq(doctorProfile.userId, userId)).limit(1);
    if (existing && existing.status !== 'rejected') throw new ConflictException('An application already exists.');
    const values = { ...input, status: 'pending' as const, submittedAt: new Date(), reviewedAt: null, reviewedBy: null };
    if (existing) {
      const [updated] = await db.update(doctorProfile).set(values).where(and(eq(doctorProfile.id, existing.id), eq(doctorProfile.status, 'rejected'))).returning();
      if (!updated) throw new ConflictException('Application changed; refresh and try again.');
      return this.applicantView(updated);
    }
    const [created] = await db.insert(doctorProfile).values({ id: randomUUID(), userId, ...values }).returning();
    return this.applicantView(created);
  }

  async getApplicationForApplicant(userId: string) {
    const [profile] = await db.select().from(doctorProfile).where(eq(doctorProfile.userId, userId)).limit(1);
    return profile ? this.applicantView(profile) : null;
  }

  async listApplications(status: 'pending' | 'approved' | 'rejected' = 'pending') {
    return db.select({
      id: doctorProfile.id, userId: doctorProfile.userId, name: user.name, email: user.email,
      specialty: doctorProfile.specialty, licenseRegion: doctorProfile.licenseRegion,
      licenseNumber: doctorProfile.licenseNumber, bio: doctorProfile.bio,
      status: doctorProfile.status, submittedAt: doctorProfile.submittedAt,
      reviewedAt: doctorProfile.reviewedAt, reviewedBy: doctorProfile.reviewedBy,
    }).from(doctorProfile).innerJoin(user, eq(user.id, doctorProfile.userId))
      .where(eq(doctorProfile.status, status)).orderBy(desc(doctorProfile.submittedAt));
  }

  async decide(applicationId: string, reviewerId: string, decision: 'approved' | 'rejected') {
    return db.transaction(async (tx) => {
      const [application] = await tx.select().from(doctorProfile)
        .where(and(eq(doctorProfile.id, applicationId), eq(doctorProfile.status, 'pending')))
        .for('update').limit(1);
      if (!application) throw new NotFoundException('Pending application not found.');
      const [applicant] = await tx.select({ id: user.id, role: user.role }).from(user)
        .where(eq(user.id, application.userId)).limit(1);
      if (!applicant || applicant.role !== 'patient') throw new ConflictException('Applicant is not an eligible patient.');

      const [updated] = await tx.update(doctorProfile).set({ status: decision, reviewedAt: new Date(), reviewedBy: reviewerId })
        .where(and(eq(doctorProfile.id, applicationId), eq(doctorProfile.status, 'pending'))).returning();
      if (!updated) throw new ConflictException('Application changed; refresh and try again.');
      if (decision === 'approved') {
        await tx.update(user).set({ role: 'doctor', updatedAt: new Date() }).where(eq(user.id, application.userId));
      }
      return { id: updated.id, userId: updated.userId, status: updated.status, reviewedAt: updated.reviewedAt };
    });
  }

  async listPublicProfiles() {
    const profiles = await db.select({ id: doctorProfile.id, name: user.name, specialty: doctorProfile.specialty, bio: doctorProfile.bio })
      .from(doctorProfile).innerJoin(user, eq(user.id, doctorProfile.userId))
      .where(and(eq(doctorProfile.status, 'approved'), eq(user.role, 'doctor')))
      .orderBy(doctorProfile.specialty);
    return profiles.map(toPublicDoctorProfile);
  }

  async getPublicProfile(id: string) {
    const [profile] = await db.select({ id: doctorProfile.id, name: user.name, specialty: doctorProfile.specialty, bio: doctorProfile.bio })
      .from(doctorProfile).innerJoin(user, eq(user.id, doctorProfile.userId))
      .where(and(eq(doctorProfile.id, id), eq(doctorProfile.status, 'approved'), eq(user.role, 'doctor'))).limit(1);
    return profile ? toPublicDoctorProfile(profile) : null;
  }

  async getOwnApprovedProfile(userId: string) {
    const [profile] = await db.select({ id: doctorProfile.id, userId: user.id, name: user.name, email: user.email, specialty: doctorProfile.specialty, licenseRegion: doctorProfile.licenseRegion, licenseNumber: doctorProfile.licenseNumber, bio: doctorProfile.bio })
      .from(doctorProfile).innerJoin(user, eq(user.id, doctorProfile.userId))
      .where(and(eq(user.id, userId), eq(doctorProfile.status, 'approved'), eq(user.role, 'doctor'))).limit(1);
    if (!profile) throw new NotFoundException('Approved doctor profile not found.');
    return profile;
  }

  private applicantView(profile: typeof doctorProfile.$inferSelect) {
    return { id: profile.id, specialty: profile.specialty, licenseRegion: profile.licenseRegion, licenseNumber: profile.licenseNumber, bio: profile.bio, status: profile.status, submittedAt: profile.submittedAt, reviewedAt: profile.reviewedAt };
  }
}
