import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller.js';
import { RolesGuard } from '../auth/roles.guard.js';

describe('appointment booking API', () => {
  it('rejects non-patient roles on booking', () => {
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => AppointmentsController.prototype.create,
      getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'd1', role: 'doctor' } }) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects non-patient roles from slot availability', () => {
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => AppointmentsController.prototype.availability,
      getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'd1', role: 'doctor' } }) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('restricts hold recovery to patients and passes only the authenticated identity', () => {
    const guard = new RolesGuard(new Reflector());
    const context = { getHandler: () => AppointmentsController.prototype.recoverHold, getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'd1', role: 'doctor' } }) }) } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    const service = { recoverPatientHold: vi.fn() };
    const controller = new AppointmentsController(service as never);
    const id = '00000000-0000-4000-8000-000000000001';
    controller.recoverHold({ id: 'patient-a', role: 'patient' } as never, id);
    expect(service.recoverPatientHold).toHaveBeenCalledWith('patient-a', id);
    expect(() => controller.recoverHold({ id: 'patient-a', role: 'patient' } as never, 'invalid')).toThrow(BadRequestException);
  });

  it('rejects malformed idempotency keys and client-supplied patient identity', () => {
    const service = { createForPatient: vi.fn() };
    const controller = new AppointmentsController(service as never);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const payload = { doctorProfileId: '00000000-0000-4000-8000-000000000001', startsAt: future, endsAt: new Date(Date.now() + 5400_000).toISOString() };
    expect(() => controller.create({ id: 'p1', role: 'patient' } as never, payload, 'invalid')).toThrow(BadRequestException);
    expect(() => controller.create({ id: 'p1', role: 'patient' } as never, { ...payload, patientId: 'p2' }, '00000000-0000-4000-8000-000000000002')).toThrow(BadRequestException);
    expect(service.createForPatient).not.toHaveBeenCalled();
  });

  it('rejects a booking when the authenticated account changed before submission', () => {
    const service = { createForPatient: vi.fn() };
    const controller = new AppointmentsController(service as never);
    const payload = { doctorProfileId: '00000000-0000-4000-8000-000000000001', startsAt: new Date(Date.now() + 3600_000).toISOString(), endsAt: new Date(Date.now() + 5400_000).toISOString() };
    expect(() => controller.create({ id: 'patient-b', role: 'patient' } as never, payload, '00000000-0000-4000-8000-000000000002', 'patient-a')).toThrow(ForbiddenException);
    expect(service.createForPatient).not.toHaveBeenCalled();
  });

  it('rejects malformed availability query parameters', () => {
    const service = { getAvailableSlots: vi.fn() };
    const controller = new AppointmentsController(service as never);
    expect(() => controller.availability({ id: 'p1', role: 'patient' } as never, { doctorProfileId: 'bad', date: 'bad' })).toThrow(BadRequestException);
    expect(service.getAvailableSlots).not.toHaveBeenCalled();
  });

  it('rejects invalid booking input without calling the service', () => {
    const service = { createForPatient: vi.fn() };
    const controller = new AppointmentsController(service as never);
    expect(() => controller.create(
      { id: 'p1', role: 'patient' } as never,
      { doctorProfileId: 'not-a-uuid', startsAt: 'invalid', endsAt: 'invalid' },
    )).toThrow(BadRequestException);
    expect(service.createForPatient).not.toHaveBeenCalled();
  });

  it('rejects booking start times before server time', () => {
    const service = { createForPatient: vi.fn() };
    const controller = new AppointmentsController(service as never);
    const start = new Date(Date.now() - 60_000).toISOString();
    expect(() => controller.create(
      { id: 'p1', role: 'patient' } as never,
      { doctorProfileId: '00000000-0000-4000-8000-000000000001', startsAt: start, endsAt: new Date(Date.now() + 60_000).toISOString() },
    )).toThrow(BadRequestException);
    expect(service.createForPatient).not.toHaveBeenCalled();
  });
});
