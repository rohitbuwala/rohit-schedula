import { BadRequestException, ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { StaffAccessController, StaffRegistrationController } from './staff-access.controller.js';
import { AuthSessionGuard } from './auth-session.guard.js';
import { RolesGuard } from './roles.guard.js';
import type { AuthenticatedUser } from './authenticated-user.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthSessionVerifier } from './auth-session-verifier.js';
import { StaffAccessService } from './staff-access.service.js';

vi.mock('./auth.js', () => ({ auth: {} }));
vi.mock('../db/database.js', () => ({ db: {} }));

const actor: AuthenticatedUser = { id: 'admin', name: 'Admin', email: 'admin@example.test', role: 'admin' };
const methods = { register: vi.fn(), registrationStatus: vi.fn(), pendingRegistrations: vi.fn(), approveRegistration: vi.fn(), create: vi.fn(), listStaff: vi.fn(), provision: vi.fn(), listAssignments: vi.fn(), assign: vi.fn(), revoke: vi.fn(), candidate: vi.fn() };
const controller = new StaffAccessController(methods as never);

beforeEach(() => vi.clearAllMocks());

describe('admin staff boundaries', () => {
  it('requires a session and the admin role for every endpoint', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, StaffAccessController)).toBe('api/admin/staff');
    expect(Reflect.getMetadata(GUARDS_METADATA, StaffAccessController)).toEqual([AuthSessionGuard, RolesGuard]);
    for (const name of ['requests', 'approve', 'create', 'list', 'provision', 'assignments', 'assign', 'revoke', 'candidate'] as const) {
      const request = { headers: {}, authUser: undefined as AuthenticatedUser | undefined };
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => StaffAccessController.prototype[name], getClass: () => StaffAccessController,
      } as unknown as ExecutionContext;
      await expect(new AuthSessionGuard({ getSession: async () => null } as never).canActivate(context))
        .rejects.toBeInstanceOf(UnauthorizedException);
      const roles = new RolesGuard(new Reflector());
      for (const role of ['patient', 'doctor', 'staff'] as const) {
        request.authUser = { ...actor, role };
        expect(() => roles.canActivate(context)).toThrow(ForbiddenException);
      }
      request.authUser = actor;
      expect(roles.canActivate(context)).toBe(true);
      expect(Reflect.getMetadata(HEADERS_METADATA, StaffAccessController.prototype[name]))
        .toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    }
  });

  it('requires confirmation and rejects role or identity injection', () => {
    for (const body of [{ userId: 'staff' }, { userId: 'staff', confirmed: true, role: 'admin' }, { userId: '', confirmed: true }]) {
      expect(() => controller.provision(actor, body)).toThrow(BadRequestException);
    }
    expect(methods.provision).not.toHaveBeenCalled();
    controller.provision(actor, { userId: 'opaque-user-id', confirmed: true });
    expect(methods.provision).toHaveBeenCalledWith(actor, 'opaque-user-id');
  });

  it('validates bounded pagination and doctor assignment bodies', () => {
    controller.list(actor, {});
    expect(methods.listStaff).toHaveBeenCalledWith(actor, 50, 0);
    for (const query of [{ limit: 101 }, { offset: -1 }, { role: 'admin' }]) {
      expect(() => controller.list(actor, query)).toThrow(BadRequestException);
    }
    expect(() => controller.assign(actor, 'staff', { doctorId: 'doctor', staffId: 'other' })).toThrow(BadRequestException);
    expect(() => controller.assignments(actor, ' ')).toThrow(BadRequestException);
    controller.assign(actor, 'staff', { doctorId: 'doctor' });
    expect(methods.assign).toHaveBeenCalledWith(actor, 'staff', 'doctor');
    controller.revoke(actor, 'staff', 'doctor');
    expect(methods.revoke).toHaveBeenCalledWith(actor, 'staff', 'doctor');
  });

  it('normalizes candidate emails and rejects extra role or identity input', () => {
    controller.candidate(actor, { email: ' STAFF@EXAMPLE.TEST ' });
    expect(methods.candidate).toHaveBeenCalledWith(actor, 'staff@example.test');
    for (const query of [{ email: 'invalid' }, { email: 'staff@example.test', role: 'admin' }]) {
      expect(() => controller.candidate(actor, query)).toThrow(BadRequestException);
    }
    expect(methods.candidate).toHaveBeenCalledTimes(1);
  });
});

describe('staff administration HTTP authorization', () => {
  let app: INestApplication;
  const verify = vi.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StaffAccessController, StaffRegistrationController], providers: [
        { provide: StaffAccessService, useValue: methods },
        { provide: AuthSessionVerifier, useValue: { getSession: verify } },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it('rejects unauthenticated and non-admin requests before any service call', async () => {
    verify.mockResolvedValue(null);
    await request(app.getHttpServer()).get('/api/admin/staff').expect(401);
    for (const role of ['patient', 'doctor', 'staff'] as const) {
      verify.mockResolvedValue({ user: { ...actor, role } });
      await request(app.getHttpServer()).post('/api/admin/staff')
        .send({ userId: 'target', confirmed: true }).expect(403);
      await request(app.getHttpServer()).get('/api/admin/staff/target/assignments').expect(403);
      await request(app.getHttpServer()).get('/api/admin/staff/candidate?email=staff@example.test').expect(403);
      await request(app.getHttpServer()).post('/api/admin/staff/accounts').send({ name: 'Staff', email: 'staff@example.test', password: 'Password123!' }).expect(403);
      await request(app.getHttpServer()).get('/api/admin/staff/requests').expect(403);
      await request(app.getHttpServer()).post('/api/admin/staff/requests/staff/approve').send({}).expect(403);
    }
    expect(methods.provision).not.toHaveBeenCalled();
    expect(methods.listAssignments).not.toHaveBeenCalled();
    expect(methods.candidate).not.toHaveBeenCalled();
    expect(methods.create).not.toHaveBeenCalled();
  });

  it('accepts public pending registration without accepting role/approval input, and protects own status', async () => {
    verify.mockResolvedValue(null); methods.register.mockResolvedValue({ status: 'pending' });
    const input = { name: 'Staff', email: 'staff@example.test', password: 'Password123!' };
    await request(app.getHttpServer()).post('/api/staff-registration').send(input).expect(201, { status: 'pending' });
    for (const extra of [{ role: 'admin' }, { status: 'approved' }]) await request(app.getHttpServer()).post('/api/staff-registration').send({ ...input, ...extra }).expect(400);
    expect(methods.register).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).get('/api/staff-registration/me').expect(401);
    verify.mockResolvedValue({ user: { ...actor, role: 'patient' } });
    await request(app.getHttpServer()).get('/api/staff-registration/me').expect(403);
    verify.mockResolvedValue({ user: { ...actor, role: 'staff' } }); methods.registrationStatus.mockResolvedValue({ status: 'pending' });
    await request(app.getHttpServer()).get('/api/staff-registration/me').expect(200, { status: 'pending' });
    expect(methods.registrationStatus).toHaveBeenCalledWith({ ...actor, role: 'staff' });
  });

  it('allows an authenticated admin and validates bodies at the actual HTTP boundary', async () => {
    verify.mockResolvedValue({ user: actor });
    methods.listStaff.mockResolvedValue([]);
    await request(app.getHttpServer()).get('/api/admin/staff?limit=10&offset=0')
      .expect('Cache-Control', 'no-store').expect(200, []);
    expect(methods.listStaff).toHaveBeenCalledWith(actor, 10, 0);
    methods.create.mockResolvedValue({ id: 'new-staff', role: 'staff' });
    await request(app.getHttpServer()).post('/api/admin/staff/accounts').send({ name: ' Staff ', email: ' STAFF@EXAMPLE.TEST ', password: 'Password123!' }).expect(201);
    expect(methods.create).toHaveBeenCalledWith(actor, { name: 'Staff', email: 'staff@example.test', password: 'Password123!' });
    methods.create.mockClear();
    for (const extra of [{ password: 'short' }, { role: 'admin' }]) {
      await request(app.getHttpServer()).post('/api/admin/staff/accounts').send({ name: 'Staff', email: 'staff@example.test', password: 'Password123!', ...extra }).expect(400);
    }
    expect(methods.create).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/api/admin/staff').send({ userId: 'target', role: 'admin' }).expect(400);
    expect(methods.provision).not.toHaveBeenCalled();
  });
});
