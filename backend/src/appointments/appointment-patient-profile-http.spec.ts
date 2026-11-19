import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import request from 'supertest';
import { AuthSessionVerifier } from '../auth/auth-session-verifier.js';
import { db } from '../db/database.js';
import { DoctorProfilesService } from '../doctors/doctor-profiles.service.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { PatientsController } from '../patients/patients.controller.js';
import { PatientsService } from '../patients/patients.service.js';
import { NotFoundException } from '@nestjs/common';

vi.mock('../auth/auth.js', () => ({ auth: {} }));
vi.mock('../db/database.js', () => ({ db: { select: vi.fn() } }));

const id = '00000000-0000-4000-8000-000000000001';
const doctor = { id: 'doctor-a', name: 'Doctor', email: 'doctor@example.test', role: 'doctor' };
const profile = { id: 'patient-a', name: 'Patient', dateOfBirth: null, gender: null, bloodGroup: null, phone: null, address: null, allergies: null };

describe('patient profile HTTP authorization', () => {
  let app: INestApplication;
  const verify = vi.fn();
  const approved = vi.fn();
  let status = 'scheduled';
  let owner = 'doctor-a';

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AppointmentsController], providers: [
      AppointmentsService,
      { provide: AuthSessionVerifier, useValue: { getSession: verify } },
      { provide: DoctorProfilesService, useValue: { isApproved: approved } },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    status = 'scheduled'; owner = 'doctor-a';
    verify.mockResolvedValue({ user: doctor });
    approved.mockResolvedValue(true);
    vi.mocked(db.select).mockReturnValue({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({
      where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => ({ limit: async () => {
        const { sql, params } = new PgDialect().sqlToQuery(condition);
        expect(sql).toContain('"appointment"."doctor_id"');
        expect(sql).toContain('"appointment"."status"');
        return params.includes(id) && params.includes(owner) && params.includes(status) ? [profile] : [];
      } }),
    }) }) }) } as never);
  });

  it.each(['scheduled', 'completed'])('allows the owning approved doctor for %s', async (value) => {
    status = value;
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient`).expect('Cache-Control', 'no-store').expect(200, profile);
  });
  it.each(['cancelled', 'pending_payment'])('denies %s appointments', async (value) => {
    status = value;
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient`).expect(404);
  });
  it('denies a different approved doctor', async () => {
    verify.mockResolvedValue({ user: { ...doctor, id: 'doctor-b' } });
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient`).expect(404);
  });
  it.each(['patient', 'staff'])('denies the %s role before reading profiles', async (role) => {
    verify.mockResolvedValue({ user: { ...doctor, role } });
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient`).expect(403);
    expect(db.select).not.toHaveBeenCalled();
  });
  it('denies an unauthenticated request before reading profiles', async () => {
    verify.mockResolvedValue(null);
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient`).expect(401);
    expect(db.select).not.toHaveBeenCalled();
  });
  it('denies an unapproved doctor', async () => {
    approved.mockResolvedValue(false);
    await request(app.getHttpServer()).get(`/api/appointments/${id}/patient`).expect(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('medical information HTTP authorization', () => {
  let app: INestApplication;
  const verify = vi.fn();
  const service = { getMedical: vi.fn(), updateMedical: vi.fn() };
  const patient = { id: 'patient-a', name: 'Patient', email: 'patient@example.test', role: 'patient' };
  const data = { allergies: null, conditions: null, revision: 0, history: [] };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [PatientsController], providers: [
      { provide: PatientsService, useValue: service }, { provide: AuthSessionVerifier, useValue: { getSession: verify } },
    ] }).compile();
    app = module.createNestApplication({ logger: false }); await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { vi.resetAllMocks(); verify.mockResolvedValue({ user: patient }); service.getMedical.mockResolvedValue(data); service.updateMedical.mockResolvedValue(data); });
  it('permits a patient to read and update only their own medical information', async () => {
    await request(app.getHttpServer()).get('/api/patients/me/medical').expect('Cache-Control', 'no-store').expect(200, data);
    await request(app.getHttpServer()).patch('/api/patients/me/medical').send({ allergies: null, conditions: null, revision: 0 }).expect(200);
    expect(service.updateMedical).toHaveBeenCalledWith(patient, { allergies: null, conditions: null, revision: 0 });
  });
  it('passes the verified doctor and appointment to the service', async () => {
    verify.mockResolvedValue({ user: doctor });
    await request(app.getHttpServer()).patch(`/api/patients/appointments/${id}/medical`).send({ allergies: 'test', conditions: null, revision: 0 }).expect(200);
    expect(service.updateMedical).toHaveBeenCalledWith(doctor, { allergies: 'test', conditions: null, revision: 0 }, id);
    service.getMedical.mockRejectedValue(new NotFoundException());
    await request(app.getHttpServer()).get(`/api/patients/appointments/${id}/medical`).expect(404);
  });
  it.each(['staff', 'admin'])('denies %s', async role => {
    verify.mockResolvedValue({ user: { ...doctor, role } });
    await request(app.getHttpServer()).get(`/api/patients/appointments/${id}/medical`).expect(403);
    await request(app.getHttpServer()).get('/api/patients/me/medical').expect(403);
    expect(service.getMedical).not.toHaveBeenCalled();
  });
  it('denies unauthenticated users', async () => {
    verify.mockResolvedValue(null);
    await request(app.getHttpServer()).get('/api/patients/me/medical').expect(401);
    expect(service.getMedical).not.toHaveBeenCalled();
  });
  it('denies a patient on the doctor route and rejects injected identity', async () => {
    await request(app.getHttpServer()).get(`/api/patients/appointments/${id}/medical`).expect(403);
    await request(app.getHttpServer()).patch('/api/patients/me/medical').send({ allergies: null, conditions: null, revision: 0, patientId: 'other' }).expect(400);
    expect(service.updateMedical).not.toHaveBeenCalled();
  });
});
