import { BadRequestException, ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-user.js';
import { AssistantController } from './assistant.controller.js';

vi.mock('../auth/auth.js', () => ({ auth: {} }));
vi.mock('../db/database.js', () => ({ db: {} }));

describe('POST /api/assistant/chat', () => {
  const verify = vi.fn();
  const chat = vi.fn();
  const cancelAppointment = vi.fn();
  const rescheduleAppointment = vi.fn();
  const controller = new AssistantController({ chat, cancelAppointment, rescheduleAppointment } as never);
  const sessionGuard = new AuthSessionGuard({ getSession: verify } as never);
  const rolesGuard = new RolesGuard(new Reflector());
  const user: AuthenticatedUser = { id: 'p1', name: 'Patient', email: 'patient@example.test', role: 'patient' };

  function executionContext(request: AuthenticatedRequest) {
    return {
      getHandler: () => AssistantController.prototype.chat,
      getClass: () => AssistantController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    verify.mockReset();
    chat.mockReset();
    cancelAppointment.mockReset();
  });

  it('requires a reason and explicit confirmation and forwards only the session actor', () => {
    const appointmentId = '00000000-0000-4000-8000-000000000001';
    for (const body of [
      { appointmentId, confirmed: true },
      { appointmentId, reason: 'schedule_conflict', confirmed: false },
      { appointmentId, reason: 'arbitrary reason', confirmed: true },
      { appointmentId, reason: 'schedule_conflict', confirmed: true, patientId: 'other' },
    ]) {
      expect(() => controller.cancel(user, body)).toThrow(BadRequestException);
    }
    expect(cancelAppointment).not.toHaveBeenCalled();
    controller.cancel(user, { appointmentId, reason: 'schedule_conflict', confirmed: true });
    expect(cancelAppointment).toHaveBeenCalledOnce();
    expect(cancelAppointment).toHaveBeenCalledWith(user, appointmentId, 'schedule_conflict');
  });

  it('requires explicit confirmation and a valid future slot before rescheduling', () => {
    rescheduleAppointment.mockClear();
    const appointmentId = '00000000-0000-4000-8000-000000000001';
    const expectedStartsAt = new Date().toISOString();
    const slot = { startsAt: new Date(Date.now() + 60_000).toISOString(), endsAt: new Date(Date.now() + 960_000).toISOString() };
    const body = { appointmentId, expectedStartsAt, slot };
    expect(() => controller.reschedule(user, body)).toThrow(BadRequestException);
    expect(() => controller.reschedule(user, { ...body, confirmed: true, patientId: 'other' })).toThrow(BadRequestException);
    expect(rescheduleAppointment).not.toHaveBeenCalled();
    controller.reschedule(user, { ...body, confirmed: true });
    expect(rescheduleAppointment).toHaveBeenCalledWith(user, expect.objectContaining({ appointmentId, expectedStartsAt: new Date(expectedStartsAt) }));
  });

  it('registers the guarded route and disables response caching', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AssistantController)).toBe('api/assistant');
    expect(Reflect.getMetadata(PATH_METADATA, AssistantController.prototype.chat)).toBe('chat');
    expect(Reflect.getMetadata(METHOD_METADATA, AssistantController.prototype.chat)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(GUARDS_METADATA, AssistantController)).toEqual([AuthSessionGuard, RolesGuard]);
    expect(Reflect.getMetadata(HEADERS_METADATA, AssistantController.prototype.chat))
      .toContainEqual({ name: 'Cache-Control', value: 'no-store' });
  });

  it('rejects missing sessions and admin sessions', async () => {
    const context = executionContext({ headers: {} });
    verify.mockResolvedValueOnce(null).mockResolvedValueOnce({ user: { ...user, role: 'admin' } });
    await expect(sessionGuard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    await sessionGuard.canActivate(context);
    expect(() => rolesGuard.canActivate(context)).toThrow(ForbiddenException);
    expect(chat).not.toHaveBeenCalled();
  });

  it.each([{ message: ' ' }, { message: 'x'.repeat(1001) }, { message: 'Hi', role: 'doctor' }])(
    'rejects invalid or extra request fields', (body) => {
      expect(() => controller.chat(user, body)).toThrow(BadRequestException);
      expect(chat).not.toHaveBeenCalled();
    },
  );

  it.each(['patient', 'doctor'] as const)('passes the verified %s identity to the service', async (role) => {
    const request: AuthenticatedRequest = { headers: { cookie: 'session=test' } };
    const actor = { ...user, role };
    verify.mockResolvedValue({ user: actor });
    const context = executionContext(request);
    await expect(sessionGuard.canActivate(context)).resolves.toBe(true);
    expect(rolesGuard.canActivate(context)).toBe(true);
    controller.chat(request.authUser!, { message: '  My appointments  ' });
    expect(chat).toHaveBeenCalledWith(actor, 'My appointments');
  });
});
