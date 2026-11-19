import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../auth/roles.guard.js';
import { AuthSessionVerifier } from '../auth/auth-session-verifier.js';
import { DoctorProfilesService } from '../doctors/doctor-profiles.service.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db/database.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';

vi.mock('../db/database.js', () => ({ db: { select: vi.fn(), transaction: vi.fn() } }));
vi.mock('../auth/auth.js', () => ({ auth: {} }));
const doctor = { id: 'doctor-1', role: 'doctor', name: 'Doctor', email: 'doctor@example.test' } as const;
const patient = { id: 'patient-1', role: 'patient', name: 'Patient', email: 'patient@example.test' } as const;
const id = '00000000-0000-4000-8000-000000000001';

describe('visit history access', () => {
  const doctors = { isApproved: vi.fn() };
  const service = new AppointmentsService(doctors as never);
  beforeEach(() => { vi.resetAllMocks(); doctors.isApproved.mockResolvedValue(true); });
  it('uses session identity for patient history and rejects other roles', async () => {
    await expect(service.patientVisitHistory(doctor)).rejects.toThrow(ForbiddenException);
    const list = vi.spyOn(service as never, 'listPatientVisits' as never).mockResolvedValue([] as never);
    await service.patientVisitHistory(patient);
    expect(list).toHaveBeenCalledWith(patient.id);
  });
  it('rejects an unapproved doctor before reading records', async () => {
    doctors.isApproved.mockResolvedValue(false);
    await expect(service.doctorPatientVisits(id, doctor)).rejects.toThrow(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });
  it('denies another doctor or ineligible appointment', async () => {
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) } as never);
    await expect(service.doctorPatientVisits(id, doctor)).rejects.toThrow(NotFoundException);
  });
  it('reads the complete history using the authorized appointment patient', async () => {
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ patientId: patient.id }] }) }) } as never);
    const list = vi.spyOn(service as never, 'listPatientVisits' as never).mockResolvedValue([] as never);
    await service.doctorPatientVisits(id, doctor);
    expect(list).toHaveBeenCalledWith(patient.id);
  });
  it('limits history to the patient, past appointments and excludes payment holds', async () => {
    let condition: Parameters<PgDialect['sqlToQuery']>[0] | undefined;
    const chain = { innerJoin: () => chain, leftJoin: () => chain,
      where: (value: typeof condition) => { condition = value; return chain; }, orderBy: async () => [] };
    vi.mocked(db.select).mockReturnValue({ from: () => chain } as never);
    await service.patientVisitHistory(patient);
    const query = new PgDialect().sqlToQuery(condition!);
    expect(query.sql).toContain('"appointment"."patient_id"');
    expect(query.sql).toContain('"appointment"."starts_at"');
    expect(query.params).toContain(patient.id);
    expect(query.params).toContain('pending_payment');
  });
  it('allows an approved doctor to save details on their qualifying appointment', async () => {
    const select = vi.fn().mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: () => ({ for: () => ({ limit: async () => [{ id }] }) }) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ for: () => ({ limit: async () => [] }) }) }) });
    const values = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation(async fn => fn({ select, insert: () => ({ values }) } as never));
    await expect(service.updateDoctorVisit(id, doctor, { notes: 'notes', details: 'details', revision: 0 })).resolves.toEqual({ notes: 'notes', details: 'details', revision: 1 });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: id, notes: 'notes', details: 'details', revision: 1 }));
  });
  it('rejects a stale note revision before writing', async () => {
    const select = vi.fn().mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: () => ({ for: () => ({ limit: async () => [{ id }] }) }) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ for: () => ({ limit: async () => [{ revision: 2 }] }) }) }) });
    const update = vi.fn();
    vi.mocked(db.transaction).mockImplementation(async fn => fn({ select, update } as never));
    await expect(service.updateDoctorVisit(id, doctor, { notes: 'note', details: 'details', revision: 1 })).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });
  it('validates note size, revision, identifiers and injected fields', () => {
    const controller = new AppointmentsController({ updateDoctorVisit: vi.fn() } as never);
    for (const value of [{ notes: 'x'.repeat(5001), details: '', revision: 0 }, { notes: '', details: '', revision: -1 },
      { notes: '', details: '', revision: 0, patientId: 'other' }]) {
      expect(() => controller.updateVisit(id, doctor, value)).toThrow(BadRequestException);
    }
    expect(() => controller.updateVisit('invalid', doctor, { notes: '', details: '', revision: 0 })).toThrow(BadRequestException);
  });
  it('restricts doctor operations to doctor role and patient history to patient role', () => {
    const guard = new RolesGuard(new Reflector());
    for (const [handler, role] of [[AppointmentsController.prototype.updateVisit, 'patient'], [AppointmentsController.prototype.doctorVisits, 'staff'], [AppointmentsController.prototype.patientVisits, 'doctor']] as const) {
      const context = { getHandler: () => handler, getClass: () => AppointmentsController,
        switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'other', role } }) }) } as unknown as ExecutionContext;
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    }
  });
});

describe('visit history HTTP guards', () => {
  let app: INestApplication;
  const verify = vi.fn();
  const approved = vi.fn();
  const visits = { patientVisitHistory: vi.fn(), doctorPatientVisits: vi.fn(), getDoctorVisit: vi.fn(), updateDoctorVisit: vi.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AppointmentsController], providers: [
      { provide: AppointmentsService, useValue: visits },
      { provide: AuthSessionVerifier, useValue: { getSession: verify } },
      { provide: DoctorProfilesService, useValue: { isApproved: approved } },
    ] }).compile();
    app = module.createNestApplication({ logger: false }); await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { vi.resetAllMocks(); approved.mockResolvedValue(true); visits.patientVisitHistory.mockResolvedValue([]); visits.doctorPatientVisits.mockResolvedValue([]); });
  it('denies unauthenticated and staff access', async () => {
    verify.mockResolvedValue(null);
    await request(app.getHttpServer()).get('/api/appointments/me/visits').expect(401);
    verify.mockResolvedValue({ user: { ...patient, role: 'staff' } });
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient/visits`).expect(403);
    expect(visits.doctorPatientVisits).not.toHaveBeenCalled();
  });
  it('permits a patient only on their own history route', async () => {
    verify.mockResolvedValue({ user: patient });
    await request(app.getHttpServer()).get('/api/appointments/me/visits').expect('Cache-Control', 'no-store').expect(200);
    expect(visits.patientVisitHistory).toHaveBeenCalledWith(patient);
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient/visits`).expect(403);
  });
  it('requires an approved doctor and delegates ownership validation to the service', async () => {
    verify.mockResolvedValue({ user: doctor }); approved.mockResolvedValue(false);
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient/visits`).expect(403);
    approved.mockResolvedValue(true); visits.doctorPatientVisits.mockRejectedValue(new NotFoundException());
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient/visits`).expect(404);
    expect(visits.doctorPatientVisits).toHaveBeenCalledWith(id, doctor);
  });
  it('allows only an approved doctor to submit their appointment notes', async () => {
    const body = { notes: 'note', details: 'visit', revision: 0 };
    verify.mockResolvedValue({ user: patient });
    await request(app.getHttpServer()).patch(`/api/appointments/${id}/visit`).send(body).expect(403);
    verify.mockResolvedValue({ user: doctor });
    visits.updateDoctorVisit.mockResolvedValue({ ...body, revision: 1 });
    await request(app.getHttpServer()).patch(`/api/appointments/${id}/visit`).send(body).expect('Cache-Control', 'no-store').expect(200);
    expect(visits.updateDoctorVisit).toHaveBeenCalledWith(id, doctor, body);
    visits.updateDoctorVisit.mockRejectedValue(new NotFoundException());
    await request(app.getHttpServer()).patch(`/api/appointments/${id}/visit`).send(body).expect(404);
  });
});
