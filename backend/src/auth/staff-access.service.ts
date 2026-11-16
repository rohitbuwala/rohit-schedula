import { ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { db } from '../db/database.js';
import { account, appointment, doctorProfile, patientProfile, session, staffDoctorAssignment, staffRegistrationRequest, user } from '../db/schema.js';
import type { AuthenticatedUser } from './authenticated-user.js';

type StaffTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const staffFields = { id: user.id, name: user.name, email: user.email, role: user.role };
const assignmentFields = {
  id: staffDoctorAssignment.id, staffId: staffDoctorAssignment.staffId,
  doctorId: staffDoctorAssignment.doctorId, assignedBy: staffDoctorAssignment.assignedBy,
  createdAt: staffDoctorAssignment.createdAt, revokedAt: staffDoctorAssignment.revokedAt,
};

@Injectable()
export class StaffAccessService {
  async register(input: { name: string; email: string; password: string }) {
    const password = await hashPassword(input.password);
    return this.transaction(async tx => {
      const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.email, input.email)).limit(1);
      if (existing) throw new ConflictException('This email already has an account. Sign in or use a different email.');
      const id = randomUUID();
      await tx.insert(user).values({ id, name: input.name, email: input.email, role: 'staff' });
      await tx.insert(account).values({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password });
      await tx.insert(staffRegistrationRequest).values({ userId: id });
      return { status: 'pending' as const };
    }, true);
  }

  async registrationStatus(actor: AuthenticatedUser) {
    if (actor.role !== 'staff') throw new ForbiddenException();
    return this.transaction(async tx => {
      const [request] = await tx.select({ status: staffRegistrationRequest.status }).from(staffRegistrationRequest)
        .where(eq(staffRegistrationRequest.userId, actor.id)).limit(1);
      return { status: request?.status ?? 'approved' };
    });
  }

  async pendingRegistrations(actor: AuthenticatedUser) {
    return this.transaction(async tx => {
      await this.requireAdmin(tx, actor);
      return tx.select({ id: user.id, name: user.name, email: user.email, requestedAt: staffRegistrationRequest.requestedAt })
        .from(staffRegistrationRequest).innerJoin(user, eq(user.id, staffRegistrationRequest.userId))
        .where(and(eq(staffRegistrationRequest.status, 'pending'), eq(user.role, 'staff')))
        .orderBy(asc(staffRegistrationRequest.requestedAt), asc(user.id)).limit(50);
    });
  }

  async approveRegistration(actor: AuthenticatedUser, staffId: string) {
    return this.transaction(async tx => {
      await this.requireAdmin(tx, actor);
      await this.lockStaff(tx, staffId);
      const [request] = await tx.select().from(staffRegistrationRequest).where(eq(staffRegistrationRequest.userId, staffId)).for('update').limit(1);
      if (!request) throw new NotFoundException('Staff request not found.');
      if (request.status !== 'approved') await tx.update(staffRegistrationRequest)
        .set({ status: 'approved', reviewedAt: new Date(), reviewedBy: actor.id }).where(eq(staffRegistrationRequest.userId, staffId));
      return { status: 'approved' as const };
    }, true);
  }

  async create(actor: AuthenticatedUser, input: { name: string; email: string; password: string }) {
    if (actor.role !== 'admin') throw new ForbiddenException();
    // Same credential format and password hashing as Better Auth email signup.
    const password = await hashPassword(input.password);
    return this.transaction(async tx => {
      await this.requireAdmin(tx, actor);
      const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.email, input.email)).limit(1);
      if (existing) throw new ConflictException('This email already has an account. Use a different dedicated staff email.');
      const id = randomUUID();
      const [created] = await tx.insert(user).values({ id, name: input.name, email: input.email, role: 'staff' }).returning(staffFields);
      await tx.insert(account).values({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password });
      // No patient profile or session is created; the administrator stays signed in.
      return created;
    }, true);
  }

  private async transaction<T>(work: (tx: StaffTransaction) => Promise<T>, serializable = false): Promise<T> {
    try {
      return await db.transaction(work, serializable ? { isolationLevel: 'serializable' } : undefined);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Drizzle may wrap PostgreSQL failures. Inspect codes only, never SQL or parameters.
      let cause: unknown = error;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        if ('code' in cause && ['40001', '40P01', '23505'].includes(String(cause.code))) {
          throw new ConflictException('Staff access changed concurrently. Refresh and retry.');
        }
        cause = 'cause' in cause ? cause.cause : undefined;
      }
      throw new InternalServerErrorException('Unable to update or read staff access.');
    }
  }

  private async requireAdmin(tx: StaffTransaction, actor: AuthenticatedUser) {
    if (actor.role !== 'admin') throw new ForbiddenException();
    const [admin] = await tx.select({ id: user.id }).from(user)
      .where(and(eq(user.id, actor.id), eq(user.role, 'admin'))).for('share').limit(1);
    if (!admin) throw new ForbiddenException();
  }

  async listStaff(actor: AuthenticatedUser, limit: number, offset: number) {
    return this.transaction(async (tx) => {
      await this.requireAdmin(tx, actor);
      return tx.select(staffFields).from(user).where(eq(user.role, 'staff'))
        .orderBy(asc(user.id)).limit(limit).offset(offset);
    });
  }

  async candidate(actor: AuthenticatedUser, email: string) {
    return this.transaction(async tx => {
      await this.requireAdmin(tx, actor);
      const [account] = await tx.select(staffFields).from(user).where(eq(user.email, email)).for('share').limit(1);
      if (!account) throw new NotFoundException('Account not found.');
      if (account.role === 'staff') return { ...account, eligible: true, reason: 'already_staff' as const };
      if (account.role !== 'patient') return { ...account, eligible: false, reason: 'protected_role' as const };
      const [doctor] = await tx.select({ id: doctorProfile.id }).from(doctorProfile).where(eq(doctorProfile.userId, account.id)).limit(1);
      const [patient] = await tx.select({ id: patientProfile.id }).from(patientProfile).where(eq(patientProfile.userId, account.id)).limit(1);
      const [booking] = await tx.select({ id: appointment.id }).from(appointment)
        .where(or(eq(appointment.patientId, account.id), eq(appointment.doctorId, account.id))).limit(1);
      const eligible = !doctor && !patient && !booking;
      return { ...account, eligible, reason: eligible ? null : 'clinical_records' as const };
    });
  }

  async provision(actor: AuthenticatedUser, userId: string) {
    return this.transaction(async (tx) => {
      await this.requireAdmin(tx, actor);
      if (actor.id === userId) throw new ConflictException('Cannot change your own role.');
      const [target] = await tx.select(staffFields).from(user)
        .where(eq(user.id, userId)).for('update').limit(1);
      if (!target) throw new NotFoundException('Account not found.');
      if (target.role === 'staff') return { id: target.id, name: target.name, email: target.email, role: target.role };
      if (target.role !== 'patient') {
        throw new ConflictException('Use an unused patient account for staff access.');
      }
      // Preserve patient records and doctor applications; never repurpose a clinical account.
      const [profile] = await tx.select({ id: doctorProfile.id }).from(doctorProfile).where(eq(doctorProfile.userId, userId)).limit(1);
      const [patient] = await tx.select({ id: patientProfile.id }).from(patientProfile).where(eq(patientProfile.userId, userId)).limit(1);
      const [booking] = await tx.select({ id: appointment.id }).from(appointment)
        .where(or(eq(appointment.patientId, userId), eq(appointment.doctorId, userId))).limit(1);
      if (profile || patient || booking) throw new ConflictException('This account already has clinical records. Use a dedicated staff account.');
      const [updated] = await tx.update(user).set({ role: 'staff', updatedAt: new Date() })
        .where(and(eq(user.id, userId), eq(user.role, 'patient'))).returning(staffFields);
      if (!updated) throw new ConflictException('Account changed; refresh and try again.');
      await tx.delete(session).where(eq(session.userId, userId));
      return updated;
    }, true);
  }

  private async lockStaff(tx: StaffTransaction, staffId: string) {
    const [staff] = await tx.select({ id: user.id }).from(user)
      .where(and(eq(user.id, staffId), eq(user.role, 'staff'))).for('update').limit(1);
    if (!staff) throw new NotFoundException('Staff account not found.');
  }

  async listAssignments(actor: AuthenticatedUser, staffId: string) {
    return this.transaction(async (tx) => {
      await this.requireAdmin(tx, actor);
      await this.lockStaff(tx, staffId);
      return tx.select(assignmentFields).from(staffDoctorAssignment)
        .where(eq(staffDoctorAssignment.staffId, staffId)).orderBy(asc(staffDoctorAssignment.doctorId));
    });
  }

  async assign(actor: AuthenticatedUser, staffId: string, doctorId: string) {
    return this.transaction(async (tx) => {
      await this.requireAdmin(tx, actor);
      await this.lockStaff(tx, staffId);
      const [registration] = await tx.select({ status: staffRegistrationRequest.status }).from(staffRegistrationRequest)
        .where(eq(staffRegistrationRequest.userId, staffId)).for('share').limit(1);
      if (registration && registration.status !== 'approved') throw new ConflictException('Approve this staff registration before assigning a doctor.');
      const [doctor] = await tx.select({ id: user.id }).from(user)
        .where(and(eq(user.id, doctorId), eq(user.role, 'doctor'))).for('share').limit(1);
      const [profile] = await tx.select({ id: doctorProfile.id }).from(doctorProfile)
        .where(and(eq(doctorProfile.userId, doctorId), eq(doctorProfile.status, 'approved'))).for('share').limit(1);
      if (!doctor || !profile) throw new NotFoundException('Approved doctor not found.');
      const [existing] = await tx.select(assignmentFields).from(staffDoctorAssignment)
        .where(and(eq(staffDoctorAssignment.staffId, staffId), eq(staffDoctorAssignment.doctorId, doctorId))).for('update').limit(1);
      if (existing && !existing.revokedAt) return existing;
      const values = { assignedBy: actor.id, createdAt: new Date(), revokedAt: null };
      const [saved] = existing
        ? await tx.update(staffDoctorAssignment).set(values).where(eq(staffDoctorAssignment.id, existing.id)).returning(assignmentFields)
        : await tx.insert(staffDoctorAssignment).values({ id: randomUUID(), staffId, doctorId, ...values }).returning(assignmentFields);
      return saved;
    });
  }

  async revoke(actor: AuthenticatedUser, staffId: string, doctorId: string) {
    return this.transaction(async (tx) => {
      await this.requireAdmin(tx, actor);
      await this.lockStaff(tx, staffId);
      const [assignment] = await tx.select(assignmentFields).from(staffDoctorAssignment)
        .where(and(eq(staffDoctorAssignment.staffId, staffId), eq(staffDoctorAssignment.doctorId, doctorId))).for('update').limit(1);
      if (!assignment) throw new NotFoundException('Assignment not found.');
      if (assignment.revokedAt) return assignment;
      const [revoked] = await tx.update(staffDoctorAssignment).set({ revokedAt: new Date() })
        .where(eq(staffDoctorAssignment.id, assignment.id)).returning(assignmentFields);
      return revoked;
    });
  }

  // Future queue mutations must call this INSIDE their transaction before acting.
  // Share locks make revocation wait for an already-authorized operation to finish.
  async assertAssigned(tx: StaffTransaction, actor: AuthenticatedUser, doctorId: string): Promise<void> {
    if (actor.role !== 'staff') throw new ForbiddenException();
    const [staff] = await tx.select({ id: user.id }).from(user)
      .where(and(eq(user.id, actor.id), eq(user.role, 'staff'))).for('share').limit(1);
    if (!staff) throw new ForbiddenException();
    const [doctor] = await tx.select({ id: user.id }).from(user)
      .where(and(eq(user.id, doctorId), eq(user.role, 'doctor'))).for('share').limit(1);
    const [profile] = await tx.select({ id: doctorProfile.id }).from(doctorProfile)
      .where(and(eq(doctorProfile.userId, doctorId), eq(doctorProfile.status, 'approved'))).for('share').limit(1);
    const [assignment] = await tx.select({ id: staffDoctorAssignment.id }).from(staffDoctorAssignment)
      .where(and(eq(staffDoctorAssignment.staffId, actor.id), eq(staffDoctorAssignment.doctorId, doctorId), isNull(staffDoctorAssignment.revokedAt)))
      .for('share').limit(1);
    if (!doctor || !profile || !assignment) throw new NotFoundException('Assigned doctor not found.');
  }
}
