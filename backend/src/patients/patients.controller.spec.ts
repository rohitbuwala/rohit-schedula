import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../auth/roles.guard.js';
import { PatientsController } from './patients.controller.js';

describe('patient profile API', () => {
  it('uses the authenticated patient ID for reads and updates, never a body ID', async () => {
    const patients = { getOwn: vi.fn(), updateOwn: vi.fn() };
    const controller = new PatientsController(patients as never);
    const sessionPatient = { id: 'patient-session-id', name: 'Patient', email: 'p@example.test', role: 'patient' as const };
    controller.getOwn(sessionPatient);
    expect(patients.getOwn).toHaveBeenCalledWith('patient-session-id');

    expect(() => controller.updateOwn(sessionPatient, { name: 'Alex', userId: 'attacker-id' })).toThrow(BadRequestException);
    expect(patients.updateOwn).not.toHaveBeenCalled();
    controller.updateOwn(sessionPatient, { name: 'Alex' });
    expect(patients.updateOwn).toHaveBeenCalledWith('patient-session-id', { name: 'Alex' });
  });

  it('denies non-patient roles on the profile route', () => {
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => PatientsController.prototype.updateOwn,
      getClass: () => PatientsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'd1', role: 'doctor' } }) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
