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

describe('appointment rescheduling controller & service', () => {
  const appointmentId = '00000000-0000-4000-8000-000000000001';
  const patientId = 'patient-123';
  const doctorId = 'doctor-456';
  const otherPatientId = 'patient-999';

  const validNewStartsAt = new Date(Date.now() + 86400000); // 1 day in future
  const validNewEndsAt = new Date(validNewStartsAt.getTime() + 30 * 60 * 1000);

  function mockTransactionWith(
    record: Record<string, unknown> | null,
    updateReturn: unknown[] = [
      {
        id: appointmentId,
        patientId,
        doctorId,
        startsAt: validNewStartsAt,
        endsAt: validNewEndsAt,
        status: 'scheduled',
        updatedAt: new Date(),
        reminderGeneration: 1,
      },
    ],
    participants?: Array<{ id: string; name: string; email: string }>,
  ) {
    const select = vi.fn().mockReturnValueOnce({
      from: vi.fn().mockReturnValueOnce({
        where: vi.fn().mockReturnValueOnce({
          for: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValue(record ? [record] : []),
          }),
        }),
      }),
    });
    if (participants) {
      select.mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce(participants),
        }),
      });
    }
    const tx = {
      select,
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

  it('rejects unauthorized roles via RolesGuard (e.g. admin)', () => {
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => AppointmentsController.prototype.reschedule,
      getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 'admin-1', role: 'admin' } }) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows patient and doctor roles via RolesGuard', () => {
    const guard = new RolesGuard(new Reflector());
    const patientContext = {
      getHandler: () => AppointmentsController.prototype.reschedule,
      getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: patientId, role: 'patient' } }) }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(patientContext)).toBe(true);

    const doctorContext = {
      getHandler: () => AppointmentsController.prototype.reschedule,
      getClass: () => AppointmentsController,
      switchToHttp: () => ({ getRequest: () => ({ authUser: { id: doctorId, role: 'doctor' } }) }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(doctorContext)).toBe(true);
  });

  it('rejects invalid UUID param with BadRequestException without calling service', () => {
    const service = { reschedule: vi.fn() };
    const controller = new AppointmentsController(service as never);
    expect(() =>
      controller.reschedule('invalid-uuid', { id: patientId, role: 'patient' } as AuthenticatedUser, {
        startsAt: validNewStartsAt.toISOString(),
        endsAt: validNewEndsAt.toISOString(),
      })
    ).toThrow(BadRequestException);
    expect(service.reschedule).not.toHaveBeenCalled();
  });

  it('rejects rescheduling if appointment does not exist or user is unauthorized', async () => {
    mockTransactionWith(null);
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);

    await expect(
      service.reschedule(appointmentId, { id: otherPatientId, role: 'patient' } as AuthenticatedUser, {
        startsAt: validNewStartsAt,
        endsAt: validNewEndsAt,
      })
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects rescheduling if appointment is cancelled or completed (409 Conflict)', async () => {
    mockTransactionWith({
      id: appointmentId,
      patientId,
      doctorId,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 1800000),
      status: 'cancelled',
    });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);

    await expect(
      service.reschedule(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser, {
        startsAt: validNewStartsAt,
        endsAt: validNewEndsAt,
      })
    ).rejects.toThrow(ConflictException);
  });

  it('rejects duration that is not 30 minutes with BadRequestException', async () => {
    mockTransactionWith({
      id: appointmentId,
      patientId,
      doctorId,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 1800000),
      status: 'scheduled',
    });
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const service = new AppointmentsService(doctors as never);

    const invalidEndsAt = new Date(validNewStartsAt.getTime() + 60 * 60 * 1000); // 60 mins
    await expect(
      service.reschedule(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser, {
        startsAt: validNewStartsAt,
        endsAt: invalidEndsAt,
      })
    ).rejects.toThrow(BadRequestException);
  });

  it('successfully updates appointment atomically and creates notifications', async () => {
    const emailOutbox = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const reminders = { cancelForAppointment: vi.fn(), scheduleForAppointment: vi.fn() };
    const scheduleService = { getTimezoneForDoctor: vi.fn().mockResolvedValue('America/New_York') };
    const tx = mockTransactionWith({
      id: appointmentId,
      patientId,
      doctorId,
      startsAt: new Date(Date.now() + 3600000),
      endsAt: new Date(Date.now() + 5400000),
      status: 'scheduled',
    }, undefined, [
      { id: patientId, name: 'Test Patient', email: 'patient@example.invalid' },
      { id: doctorId, name: 'Test Doctor', email: 'doctor@example.invalid' },
    ]);
    const doctors = { isApproved: vi.fn().mockResolvedValue(true) };
    const notifications = { createNotification: vi.fn().mockResolvedValue({}) };
    const service = new AppointmentsService(doctors as never, scheduleService as never, notifications as never, undefined, undefined, emailOutbox as never, reminders as never);

    const result = await service.reschedule(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser, {
      startsAt: validNewStartsAt,
      endsAt: validNewEndsAt,
    });

    expect(result.id).toBe(appointmentId);
    expect(tx.update).toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledTimes(2); // for both patient & doctor
    expect(notifications.createNotification.mock.calls.map(([notification]) => notification.message).join(' ')).toContain('(America/New_York)');
    expect(emailOutbox.enqueue).toHaveBeenCalledTimes(2);
    expect(reminders.cancelForAppointment).toHaveBeenCalledWith(tx, appointmentId);
    expect(reminders.scheduleForAppointment).toHaveBeenCalledWith(tx, expect.objectContaining({ reminderGeneration: 1 }), 'America/New_York');
    expect(emailOutbox.enqueue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: 'appointment_rescheduled',
        appointmentId,
        payload: expect.objectContaining({ timezone: 'America/New_York' }),
      }),
    );
  });
});
