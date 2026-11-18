import { ConflictException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { StaffAccessService } from './staff-access.service.js';
import { db } from '../db/database.js';
import { session, staffRegistrationRequest } from '../db/schema.js';
import { verifyPassword } from 'better-auth/crypto';
import type { AuthenticatedUser } from './authenticated-user.js';

vi.mock('../db/database.js', () => ({ db: { transaction: vi.fn() } }));
const admin: AuthenticatedUser = { id: 'admin', name: 'Admin', email: 'admin@example.test', role: 'admin' };
const staff: AuthenticatedUser = { ...admin, id: 'staff', role: 'staff' };
const existing = { id: 'assignment', staffId: 'staff', doctorId: 'doctor', assignedBy: 'admin', createdAt: new Date(), revokedAt: null };
const dialect = new PgDialect();

describe('staff access persistence', () => {
  it('creates a credential staff account with a Better Auth password hash and no patient profile/session', async () => {
    responses.push([{ id: 'admin' }], [], [{ id: 'new-staff', role: 'staff' }], []);
    await expect(service.create(admin, { name: 'Staff', email: 'staff@example.test', password: 'Password123!' })).resolves.toEqual({ id: 'new-staff', role: 'staff' });
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(queries[2].values).toHaveBeenCalledWith(expect.objectContaining({ role: 'staff', email: 'staff@example.test' }));
    const credential = queries[3].values.mock.calls[0][0];
    expect(credential.providerId).toBe('credential'); expect(credential.accountId).toBe(credential.userId);
    expect(credential.password).not.toBe('Password123!');
    expect(await verifyPassword({ hash: credential.password, password: 'Password123!' })).toBe(true);
    expect(tx.update).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
  });
  it('refuses duplicate emails and non-admin account creation', async () => {
    await expect(service.create(staff, { name: 'Staff', email: 'staff@example.test', password: 'Password123!' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.transaction).not.toHaveBeenCalled();
    responses.push([{ id: 'admin' }], [{ id: 'patient-with-records' }]);
    await expect(service.create(admin, { name: 'Staff', email: 'staff@example.test', password: 'Password123!' })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.insert).not.toHaveBeenCalled();
  });
  let service: StaffAccessService;
  let responses: unknown[][];
  let queries: ReturnType<typeof query>[];
  let registrationRows: unknown[];
  let tx: { select: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  function query(rows?: unknown[]) {
    const chain = {
      from: vi.fn(), where: vi.fn(), for: vi.fn(), limit: vi.fn().mockResolvedValue(rows),
      orderBy: vi.fn(), offset: vi.fn().mockResolvedValue(rows), set: vi.fn(), values: vi.fn(), returning: vi.fn().mockResolvedValue(rows),
    };
    for (const name of ['from', 'where', 'for', 'orderBy', 'set', 'values'] as const) chain[name].mockReturnValue(chain);
    if (rows === undefined) chain.from.mockImplementation(table => {
      const result = table === staffRegistrationRequest ? registrationRows : responses.shift() ?? [];
      chain.limit.mockResolvedValue(result); chain.offset.mockResolvedValue(result); return chain;
    });
    queries.push(chain);
    return chain;
  }
  beforeEach(() => {
    vi.clearAllMocks(); service = new StaffAccessService(); responses = []; queries = []; registrationRows = [];
    tx = { select: vi.fn(() => query()),
      update: vi.fn(() => query(responses.shift() ?? [])), insert: vi.fn(() => query(responses.shift() ?? [])),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) };
    vi.mocked(db.transaction).mockImplementation(async (callback) => callback(tx as never));
  });

  it('registers a pending staff account without creating a session, clinical profile or assignment', async () => {
    responses.push([], [], [], []);
    await expect(service.register({ name: 'New Staff', email: 'new@example.test', password: 'Password123!' })).resolves.toEqual({ status: 'pending' });
    expect(tx.insert).toHaveBeenCalledTimes(3);
    expect(queries[1].values).toHaveBeenCalledWith(expect.objectContaining({ role: 'staff' }));
    expect(queries[3].values).toHaveBeenCalledWith({ userId: expect.any(String) });
    expect(tx.update).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
  });
  it('prevents assignment while pending, permits idempotent approval only by admins and exposes own status', async () => {
    registrationRows = [{ userId: 'staff', status: 'pending' }];
    responses.push([{ id: 'admin' }], [{ id: 'staff' }]);
    await expect(service.assign(admin, 'staff', 'doctor')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.insert).not.toHaveBeenCalled();
    await expect(service.registrationStatus(staff)).resolves.toEqual({ status: 'pending' });
    responses.push([{ id: 'admin' }], [{ id: 'staff' }], []);
    await expect(service.approveRegistration(admin, 'staff')).resolves.toEqual({ status: 'approved' });
    expect(tx.update).toHaveBeenCalledTimes(1);
    registrationRows = [{ status: 'approved' }];
    responses.push([{ id: 'admin' }], [{ id: 'staff' }]);
    await expect(service.approveRegistration(admin, 'staff')).resolves.toEqual({ status: 'approved' });
    expect(tx.update).toHaveBeenCalledTimes(1);
    await expect(service.approveRegistration(staff, 'staff')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not allow role input at public signup and routes staff separately in both login flows', () => {
    const auth = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
    expect(auth).toMatch(/role: \{[^\n]+input: false/);
    for (const path of ['../../../frontend/lib/auth-server.ts', '../../../frontend/components/auth-form.tsx']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).toContain('"staff"'); expect(source).toContain('"/staff/dashboard"');
    }
    const shell = readFileSync(new URL('../../../frontend/components/app-shell.tsx', import.meta.url), 'utf8');
    expect(shell).toContain('role === "staff"');
  });

  it('rejects forged or revoked admin privileges before changing any account', async () => {
    await expect(service.provision(staff, 'target')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.provision(admin, 'target')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.update).not.toHaveBeenCalled(); expect(tx.insert).not.toHaveBeenCalled();
  });

  it.each(['doctor', 'admin'])('never repurposes a %s account', async (role) => {
    responses.push([{ id: 'admin' }], [{ id: 'target', role }]);
    await expect(service.provision(admin, 'target')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('rejects accounts with clinical records', async () => {
    for (let clinicalTable = 0; clinicalTable < 3; clinicalTable++) {
      responses.push([{ id: 'admin' }], [{ id: 'target', role: 'patient' }],
        ...[0, 1, 2].map(index => index === clinicalTable ? [{ id: 'clinical' }] : []));
      await expect(service.provision(admin, 'target')).rejects.toBeInstanceOf(ConflictException);
    }
    expect(tx.update).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
  });

  it('provisions only an unused account and invalidates its sessions atomically', async () => {
    const saved = { id: 'target', name: 'Staff', email: 'staff@example.test', role: 'staff' };
    responses.push([{ id: 'admin' }], [{ ...saved, role: 'patient' }], [], [], [], [saved]);
    await expect(service.provision(admin, 'target')).resolves.toEqual(saved);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'serializable' });
    expect(tx.delete).toHaveBeenCalledWith(session);
    expect(queries[1].for).toHaveBeenCalledWith('update');
    expect(queries[5].set).toHaveBeenCalledWith({ role: 'staff', updatedAt: expect.any(Date) });
  });

  it('keeps repeat provisioning idempotent and rejects self changes', async () => {
    responses.push([{ id: 'admin' }], [{ id: 'staff', role: 'staff', name: 'Staff', email: 'staff@example.test' }]);
    await expect(service.provision(admin, 'staff')).resolves.toMatchObject({ role: 'staff' });
    responses.push([{ id: 'admin' }]);
    await expect(service.provision(admin, 'admin')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.update).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
  });

  it('assigns only an approved doctor and returns an existing active assignment unchanged', async () => {
    responses.push([{ id: 'admin' }], [{ id: 'staff' }], [{ id: 'doctor' }], [{ id: 'profile' }], [existing]);
    await expect(service.assign(admin, 'staff', 'doctor')).resolves.toEqual(existing);
    expect(tx.insert).not.toHaveBeenCalled();
    responses.push([{ id: 'admin' }], [{ id: 'staff' }], [{ id: 'doctor' }], []);
    await expect(service.assign(admin, 'staff', 'doctor')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('creates assignments and reactivates revoked pairs without duplicate rows', async () => {
    responses.push([{ id: 'admin' }], [{ id: 'staff' }], [{ id: 'doctor' }], [{ id: 'profile' }], [], [existing]);
    await expect(service.assign(admin, 'staff', 'doctor')).resolves.toEqual(existing);
    expect(queries.find(item => item.values.mock.calls.length)?.values).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'staff', doctorId: 'doctor', revokedAt: null }));
    responses.push([{ id: 'admin' }], [{ id: 'staff' }], [{ id: 'doctor' }], [{ id: 'profile' }], [{ ...existing, revokedAt: new Date() }], [existing]);
    await expect(service.assign(admin, 'staff', 'doctor')).resolves.toEqual(existing);
    expect(tx.insert).toHaveBeenCalledTimes(1); expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it('revokes persistently and returns repeat revocation unchanged', async () => {
    const revoked = { ...existing, revokedAt: new Date() };
    responses.push([{ id: 'admin' }], [{ id: 'staff' }], [existing], [revoked]);
    await expect(service.revoke(admin, 'staff', 'doctor')).resolves.toEqual(revoked);
    responses.push([{ id: 'admin' }], [{ id: 'staff' }], [revoked]);
    await expect(service.revoke(admin, 'staff', 'doctor')).resolves.toEqual(revoked);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it('requires current staff role, approved doctor and an active scoped assignment on every action', async () => {
    responses.push([{ id: 'staff' }], [{ id: 'doctor' }], [{ id: 'profile' }], [existing]);
    await expect(service.assertAssigned(tx as never, staff, 'doctor')).resolves.toBeUndefined();
    const predicate = dialect.sqlToQuery(queries[3].where.mock.calls[0][0]);
    expect(predicate.params).toEqual(['staff', 'doctor']); expect(predicate.sql).toContain('"revoked_at" is null');
    for (const entry of queries) expect(entry.for).toHaveBeenCalledWith('share');
    responses.push([{ id: 'staff' }], [{ id: 'doctor' }], [{ id: 'profile' }], []);
    await expect(service.assertAssigned(tx as never, staff, 'doctor')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.assertAssigned(tx as never, staff, 'doctor')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.assertAssigned(tx as never, admin, 'doctor')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps migration 0018 additive without recreating appointment history from 0005', () => {
    const migration = readFileSync(new URL('../../drizzle/0018_staff_access.sql', import.meta.url), 'utf8');
    expect(migration).toContain('CREATE TABLE "staff_doctor_assignment"');
    expect(migration).toContain('ADD VALUE \'staff\'');
    expect(migration).not.toMatch(/CREATE TABLE "appointment_history"|ALTER TABLE "appointment_history"|DROP\s|TRUNCATE\s|DELETE FROM/i);
    const previous = JSON.parse(readFileSync(new URL('../../drizzle/meta/0017_snapshot.json', import.meta.url), 'utf8'));
    const current = JSON.parse(readFileSync(new URL('../../drizzle/meta/0018_snapshot.json', import.meta.url), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    expect(current.tables['public.staff_doctor_assignment'].foreignKeys).toHaveProperty('staff_doctor_assignment_assigned_by_user_id_fk');
    expect(current.enums['public.user_role'].values).toEqual(['patient', 'doctor', 'admin', 'staff']);
  });

  it('returns safe conflicts for transaction races and never exposes underlying SQL', async () => {
    for (const code of ['40001', '40P01', '23505']) {
      vi.mocked(db.transaction).mockRejectedValueOnce({ cause: { code, query: 'sensitive SQL' } });
      await expect(service.provision(admin, 'target')).rejects.toBeInstanceOf(ConflictException);
    }
    vi.mocked(db.transaction).mockRejectedValueOnce(new Error('sensitive SQL'));
    await expect(service.listStaff(admin, 50, 0)).rejects.toEqual(new InternalServerErrorException('Unable to update or read staff access.'));
  });

  it('does not authorize an unapproved or demoted doctor even with a stored assignment', async () => {
    for (const [doctor, profile] of [[[], [{ id: 'profile' }]], [[{ id: 'doctor' }], []]]) {
      responses.push([{ id: 'staff' }], doctor, profile, [existing]);
      await expect(service.assertAssigned(tx as never, staff, 'doctor')).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('looks up an eligible account for admins without returning clinical fields or mutating data', async () => {
    const account = { id: 'unused', name: 'Staff Candidate', email: 'staff@example.test', role: 'patient' };
    responses.push([{ id: 'admin' }], [account], [], [], []);
    await expect(service.candidate(admin, account.email)).resolves.toEqual({ ...account, eligible: true, reason: null });
    expect(dialect.sqlToQuery(queries[1].where.mock.calls[0][0]).params).toEqual([account.email]);
    for (const method of [tx.update, tx.insert, tx.delete]) expect(method).not.toHaveBeenCalled();
  });

  it('identifies protected and existing staff accounts without exposing patient records', async () => {
    for (const role of ['admin', 'doctor', 'staff']) {
      responses.push([{ id: 'admin' }], [{ id: 'target', role }]);
      await expect(service.candidate(admin, 'staff@example.test')).resolves.toMatchObject({ eligible: role === 'staff', reason: role === 'staff' ? 'already_staff' : 'protected_role' });
    }
    responses.push([{ id: 'admin' }], [{ id: 'target', role: 'patient' }], [{ id: 'profile' }], [], []);
    await expect(service.candidate(admin, 'staff@example.test')).resolves.toMatchObject({ eligible: false, reason: 'clinical_records' });
    await expect(service.candidate(staff, 'staff@example.test')).rejects.toBeInstanceOf(ForbiddenException);
    for (const method of [tx.update, tx.insert, tx.delete]) expect(method).not.toHaveBeenCalled();
  });
});
