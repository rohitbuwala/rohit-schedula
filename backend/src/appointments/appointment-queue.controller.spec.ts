import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppointmentQueueController } from './appointment-queue.controller.js';
import { AppointmentQueueService } from './appointment-queue.service.js';
import { AuthSessionVerifier } from '../auth/auth-session-verifier.js';

vi.mock('../auth/auth.js', () => ({ auth: {} }));
vi.mock('../db/database.js', () => ({ db: {} }));
const id = '00000000-0000-4000-8000-000000000001';
const actor = { id: 'actor', name: 'Actor', email: 'actor@example.test', role: 'doctor' };

describe('queue HTTP contracts and role boundaries', () => {
  let app: INestApplication;
  const verify = vi.fn();
  const service = { checkIn: vi.fn(), ownAttendance: vi.fn(), read: vi.fn(), assignments: vi.fn(), next: vi.fn(), noShow: vi.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AppointmentQueueController], providers: [
      { provide: AppointmentQueueService, useValue: service },
      { provide: AuthSessionVerifier, useValue: { getSession: verify } },
    ] }).compile();
    app = module.createNestApplication({ logger: false }); await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { vi.clearAllMocks(); verify.mockResolvedValue({ user: actor }); });

  it('denies unauthenticated requests before queue service access', async () => {
    verify.mockResolvedValue(null);
    await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send({}).expect(401);
    await request(app.getHttpServer()).get('/api/queues?doctorId=doctor&date=2026-11-16').expect(401);
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it('allows only doctors/staff to check in and returns 200 with no-store for idempotent requests', async () => {
    service.checkIn.mockResolvedValue({ appointmentId: id, tokenNumber: 1, position: 1 });
    for (const role of ['doctor', 'staff']) {
      verify.mockResolvedValue({ user: { ...actor, role } });
      await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send({})
        .expect('Cache-Control', 'no-store').expect(200, { appointmentId: id, tokenNumber: 1, position: 1 });
    }
    for (const role of ['patient', 'admin']) {
      verify.mockResolvedValue({ user: { ...actor, role } });
      await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send({}).expect(403);
    }
    expect(service.checkIn).toHaveBeenCalledTimes(2);
  });

  it('rejects appointment/actor/token injection rather than accepting client queue state', async () => {
    await request(app.getHttpServer()).post('/api/appointments/not-an-id/check-in').send({}).expect(400);
    for (const body of [{ patientId: 'other' }, { checkedInBy: 'admin' }, { tokenNumber: 1 }, { timezone: 'UTC' }]) {
      await request(app.getHttpServer()).post(`/api/appointments/${id}/check-in`).send(body).expect(400);
    }
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it('keeps patient attendance in its own route and derives identity only from the session', async () => {
    verify.mockResolvedValue({ user: { ...actor, role: 'patient' } });
    service.ownAttendance.mockResolvedValue({ appointments: [] });
    await request(app.getHttpServer()).get(`/api/queues/mine?appointmentIds=${id}`)
      .expect('Cache-Control', 'no-store').expect(200);
    expect(service.ownAttendance).toHaveBeenCalledWith({ ...actor, role: 'patient' }, [id]);
    await request(app.getHttpServer()).get(`/api/queues/mine?appointmentIds=${id}&patientId=other`).expect(400);
    for (const role of ['doctor', 'staff', 'admin']) {
      verify.mockResolvedValue({ user: { ...actor, role } });
      await request(app.getHttpServer()).get(`/api/queues/mine?appointmentIds=${id}`).expect(403);
    }
  });

  it('validates operational pagination and restricts patient/admin access', async () => {
    service.read.mockResolvedValue({ waiting: [] }); service.assignments.mockResolvedValue([]);
    await request(app.getHttpServer()).get('/api/queues?doctorId=doctor&date=2026-11-16&limit=10&cursor=1:0').expect(200);
    expect(service.read).toHaveBeenCalledWith(actor, { doctorId: 'doctor', date: '2026-11-16', limit: 10, cursor: '1:0' });
    await request(app.getHttpServer()).get('/api/queues?doctorId=doctor&date=2026-11-16&limit=101').expect(400);
    await request(app.getHttpServer()).get('/api/queues/assignments').expect('Cache-Control', 'no-store').expect(200);
    for (const role of ['patient', 'admin']) {
      verify.mockResolvedValue({ user: { ...actor, role } });
      await request(app.getHttpServer()).get('/api/queues?doctorId=doctor&date=2026-11-16').expect(403);
      await request(app.getHttpServer()).get('/api/queues/assignments').expect(403);
    }
  });

  it('restricts next-patient to doctors and rejects missing versions or injected identities', async () => {
    service.next.mockResolvedValue({ status: 'in_service' });
    await request(app.getHttpServer()).post('/api/queues/actor/next')
      .send({ serviceDate: '2026-11-16', expectedQueueVersion: 7 }).expect('Cache-Control', 'no-store').expect(200);
    await request(app.getHttpServer()).post('/api/queues/actor/next').send({ serviceDate: '2026-11-16' }).expect(400);
    await request(app.getHttpServer()).post('/api/queues/actor/next')
      .send({ serviceDate: '2026-11-16', expectedQueueVersion: 7, patientId: 'other' }).expect(400);
    for (const role of ['staff', 'patient', 'admin']) {
      verify.mockResolvedValue({ user: { ...actor, role } });
      await request(app.getHttpServer()).post('/api/queues/actor/next').send({ serviceDate: '2026-11-16', expectedQueueVersion: 7 }).expect(403);
    }
    expect(service.next).toHaveBeenCalledTimes(1);
  });

  it('allows doctors/staff to mark no-show while rejecting token, status and actor injection', async () => {
    service.noShow.mockResolvedValue({ status: 'no_show' });
    for (const role of ['doctor', 'staff']) {
      verify.mockResolvedValue({ user: { ...actor, role } });
      await request(app.getHttpServer()).post(`/api/appointments/${id}/no-show`).send({ expectedAttendanceVersion: 0 })
        .expect('Cache-Control', 'no-store').expect(200);
      await request(app.getHttpServer()).post(`/api/appointments/${id}/no-show`).send({ tokenNumber: 1, actorId: 'other' }).expect(400);
    }
    verify.mockResolvedValue({ user: { ...actor, role: 'patient' } });
    await request(app.getHttpServer()).post(`/api/appointments/${id}/no-show`).send({}).expect(403);
    expect(service.noShow).toHaveBeenCalledTimes(2);
  });
});
