import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: {
    transaction: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

describe('appointment cancellation controller', () => {
  const validId = '00000000-0000-4000-8000-000000000001';

  it('rejects unauthorized roles via RolesGuard (e.g. admin)', () => {
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => AppointmentsController.prototype.cancel,
      getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'admin-1', role: 'admin' } }) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows patient and doctor roles via RolesGuard', () => {
    const guard = new RolesGuard(new Reflector());
    const patientContext = {
      getHandler: () => AppointmentsController.prototype.cancel,
      getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'patient-1', role: 'patient' } }) }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(patientContext)).toBe(true);

    const doctorContext = {
      getHandler: () => AppointmentsController.prototype.cancel,
      getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'doctor-1', role: 'doctor' } }) }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(doctorContext)).toBe(true);
  });

  it('rejects invalid UUID param with BadRequestException without calling service', () => {
    const service = { cancel: vi.fn() };
    const controller = new AppointmentsController(service as never);
    expect(() => controller.cancel('not-a-uuid', { id: 'p1', role: 'patient' } as AuthenticatedUser)).toThrow(BadRequestException);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('forwards valid UUID to service.cancel()', async () => {
    const service = { cancel: vi.fn().mockResolvedValue({ id: validId, status: 'cancelled' }) };
    const controller = new AppointmentsController(service as never);
    const result = await controller.cancel(validId, { id: 'p1', role: 'patient' } as AuthenticatedUser);
    expect(service.cancel).toHaveBeenCalledWith(validId, { id: 'p1', role: 'patient' });
    expect(result).toEqual({ id: validId, status: 'cancelled' });
  });
});

describe('appointment cancellation service logic', () => {
  const appointmentId = '00000000-0000-4000-8000-000000000001';
  const patientId = 'patient-123';
  const doctorId = 'doctor-456';
  const otherPatientId = 'patient-999';
  const otherDoctorId = 'doctor-999';

  function mockTransactionWith(record: Record<string, unknown> | null, updateReturn: unknown[] = [{ id: appointmentId, status: 'cancelled', updatedAt: new Date() }]) {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(record ? [record] : []),
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(updateReturn),
          }),
        }),
      }),
    };
    (db.transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx));
    return tx;
  }

  it('rejects an unapproved doctor with ForbiddenException', async () => {
    const doctors = { isApproved: vi.fn().mockResolvedValue(false) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.cancel(appointmentId, { id: doctorId, role: 'doctor' } as AuthenticatedUser))
      .rejects.toThrow(ForbiddenException);
    expect(doctors.isApproved).toHaveBeenCalledWith(doctorId);
  });

  it('rejects an unsupported role with ForbiddenException', async () => {
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.cancel(appointmentId, { id: 'admin-1', role: 'admin' as never } as AuthenticatedUser))
      .rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException if appointment does not exist', async () => {
    mockTransactionWith(null);
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.cancel(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser))
      .rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException if a patient tries to cancel someone else appointment', async () => {
    mockTransactionWith({ id: appointmentId, patientId, doctorId, status: 'scheduled' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.cancel(appointmentId, { id: otherPatientId, role: 'patient' } as AuthenticatedUser))
      .rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException if a doctor tries to cancel another doctor appointment', async () => {
    mockTransactionWith({ id: appointmentId, patientId, doctorId, status: 'scheduled' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.cancel(appointmentId, { id: otherDoctorId, role: 'doctor' } as AuthenticatedUser))
      .rejects.toThrow(NotFoundException);
  });

  it('successfully cancels when owning patient requests it', async () => {
    const tx = mockTransactionWith({ id: appointmentId, patientId, doctorId, status: 'scheduled' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    const result = await service.cancel(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser);
    expect(result.status).toBe('cancelled');
    expect(tx.update).toHaveBeenCalled();
  });

  it('successfully cancels when assigned approved doctor requests it', async () => {
    const tx = mockTransactionWith({ id: appointmentId, patientId, doctorId, status: 'scheduled' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    const result = await service.cancel(appointmentId, { id: doctorId, role: 'doctor' } as AuthenticatedUser);
    expect(result.status).toBe('cancelled');
    expect(tx.update).toHaveBeenCalled();
  });

  it('rejects repeated cancellation with ConflictException (409) if appointment is already cancelled', async () => {
    mockTransactionWith({ id: appointmentId, patientId, doctorId, status: 'cancelled' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.cancel(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser))
      .rejects.toThrow(ConflictException);
  });

  it('rejects cancellation with ConflictException (409) if appointment is completed', async () => {
    mockTransactionWith({ id: appointmentId, patientId, doctorId, status: 'completed' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.cancel(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser))
      .rejects.toThrow(ConflictException);
  });

  it('throws ConflictException if concurrent modification causes update to return empty', async () => {
    mockTransactionWith({ id: appointmentId, patientId, doctorId, status: 'scheduled' }, []);
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.cancel(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser))
      .rejects.toThrow(ConflictException);
  });
});

describe('appointment completion logic', () => {
  const appointmentId = '00000000-0000-4000-8000-000000000001';
  const doctorId = 'doctor-456';
  const otherDoctorId = 'doctor-999';

  function mockTransactionWith(record: Record<string, unknown> | null, updateReturn: unknown[] = [{ id: appointmentId, status: 'completed', updatedAt: new Date() }]) {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(record ? [record] : []),
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(updateReturn),
          }),
        }),
      }),
    };
    (db.transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx));
    return tx;
  }

  it('rejects completion if actor is not a doctor', async () => {
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.complete(appointmentId, { id: 'patient-1', role: 'patient' } as AuthenticatedUser))
      .rejects.toThrow(ForbiddenException);
  });

  it('rejects completion if doctor is unapproved', async () => {
    const doctors = { isApproved: vi.fn().mockResolvedValue(false) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.complete(appointmentId, { id: doctorId, role: 'doctor' } as AuthenticatedUser))
      .rejects.toThrow(ForbiddenException);
  });

  it('rejects completion if doctor is not assigned to the appointment', async () => {
    mockTransactionWith({ id: appointmentId, doctorId, status: 'scheduled' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.complete(appointmentId, { id: otherDoctorId, role: 'doctor' } as AuthenticatedUser))
      .rejects.toThrow(NotFoundException);
  });

  it('rejects completion if appointment is already completed or cancelled', async () => {
    mockTransactionWith({ id: appointmentId, doctorId, status: 'completed' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    await expect(service.complete(appointmentId, { id: doctorId, role: 'doctor' } as AuthenticatedUser))
      .rejects.toThrow(ConflictException);
  });

  it('successfully completes appointment when assigned approved doctor finishes consultation', async () => {
    const tx = mockTransactionWith({ id: appointmentId, doctorId, status: 'scheduled' });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);
    const result = await service.complete(appointmentId, { id: doctorId, role: 'doctor' } as AuthenticatedUser);
    expect(result.status).toBe('completed');
    expect(tx.update).toHaveBeenCalled();
  });
});
