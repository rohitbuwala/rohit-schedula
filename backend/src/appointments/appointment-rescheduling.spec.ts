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

  const validNewStartsAt = (() => {
    const date = new Date();
    const daysUntilMonday = ((8 - date.getUTCDay()) % 7) || 7;
    date.setUTCDate(date.getUTCDate() + daysUntilMonday);
    date.setUTCHours(10, 0, 0, 0);
    return date;
  })();
  const validNewEndsAt = new Date(validNewStartsAt.getTime() + 30 * 60 * 1000);
  const availableSchedule = {
    timezone: 'UTC', activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24,
    slotDurationMinutes: 30, breakStart: null, breakEnd: null, leaveDates: [], dateOverrides: [],
  };

  function scheduleServiceWith(config: Record<string, unknown>) {
    return {
      getScheduleConfigForDoctor: vi.fn().mockResolvedValue(config),
      getTimezoneForDoctor: vi.fn().mockResolvedValue(config.timezone ?? 'UTC'),
    };
  }

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
    // Lock order: (1) read doctorId from appointment, (2) lock doctor profile, (3) lock appointment FOR UPDATE
    const results = [
      record ? [{ doctorId: record.doctorId ?? doctorId }] : [], // 1. read doctorId (no lock)
      [{}], // 2. doctor row capacity lock (FOR UPDATE)
      record ? [record] : [], // 3. appointment row lock (FOR UPDATE)
      [], // weekly capacity falls back to one
      [], // no date override
      [], // no overlapping appointments
      ...(participants ? [participants] : []),
    ];
    const select = vi.fn(() => {
      const result = results.shift() ?? [];
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        for: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return builder;
    });
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

  it('rejects stale previews and changed availability before writing', async () => {
    const startsAt = new Date('2027-01-04T09:00:00Z');
    const slot = { startsAt: new Date('2027-01-04T10:00:00Z'), endsAt: new Date('2027-01-04T10:30:00Z') };
    const actor = { id: patientId, role: 'patient' } as AuthenticatedUser;
    const getScheduleConfigForDoctor = vi.fn().mockResolvedValue({
      timezone: 'UTC', activeDays: [1], startHour: 9, endHour: 17, slotDurationMinutes: 30, leaveDates: ['2027-01-04'],
    });
    const service = new AppointmentsService({ isApproved: vi.fn().mockResolvedValue(true) } as never, { getScheduleConfigForDoctor } as never);
    const record = { id: appointmentId, patientId, doctorId, startsAt, status: 'scheduled' };
    const stale = mockTransactionWith(record);
    await expect(service.reschedule(appointmentId, actor, slot, new Date('2027-01-04T09:30:00Z')))
      .rejects.toBeInstanceOf(ConflictException);
    expect(stale.update).not.toHaveBeenCalled();
    const tx = mockTransactionWith(record);
    await expect(service.reschedule(appointmentId, actor, slot, startsAt)).rejects.toBeInstanceOf(ConflictException);
    expect(getScheduleConfigForDoctor).toHaveBeenCalledWith(doctorId);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('returns a conflict when PostgreSQL rejects a competing slot update', async () => {
    const startsAt = new Date('2027-01-04T09:00:00Z');
    const endsAt = new Date('2027-01-04T09:30:00Z');
    const slot = { startsAt: new Date('2027-01-04T10:00:00Z'), endsAt: new Date('2027-01-04T10:30:00Z') };
    const service = new AppointmentsService({ isApproved: vi.fn().mockResolvedValue(true) } as never, {
      getScheduleConfigForDoctor: vi.fn().mockResolvedValue({ timezone: 'UTC', activeDays: [1], startHour: 9, endHour: 17, slotDurationMinutes: 30 }),
    } as never);
    const tx = mockTransactionWith({ id: appointmentId, patientId, doctorId, startsAt, endsAt, status: 'scheduled' });
    tx.update.mockImplementationOnce(() => {
      throw new Error('Failed query', { cause: { code: '23P01' } });
    });
    await expect(service.reschedule(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser, slot, startsAt))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tx.update).toHaveBeenCalledOnce();
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

  it.each([
    ['leave dates', { ...availableSchedule, leaveDates: [validNewStartsAt.toISOString().slice(0, 10)] }, validNewStartsAt],
    ['breaks', { ...availableSchedule, activeDays: [1], breakStart: '09:30', breakEnd: '10:30' }, validNewStartsAt],
    ['inactive weekdays', { ...availableSchedule, activeDays: [2] }, validNewStartsAt],
    ['override duration', {
      ...availableSchedule,
      dateOverrides: [{ date: validNewStartsAt.toISOString().slice(0, 10), startHour: 9, endHour: 12, slotDurationMinutes: 15, breakStart: null, breakEnd: null }],
    }, validNewStartsAt],
  ])('rejects rescheduling onto %s', async (_caseName, config, startsAt) => {
    mockTransactionWith({
      id: appointmentId, patientId, doctorId,
      startsAt: new Date(Date.now() + 3600000), endsAt: new Date(Date.now() + 5400000), status: 'scheduled',
    });
    const service = new AppointmentsService(
      { isApproved: vi.fn().mockResolvedValue(true) } as never,
      scheduleServiceWith(config as Record<string, unknown>) as never,
    );

    await expect(service.reschedule(appointmentId, { id: patientId, role: 'patient' } as AuthenticatedUser, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    })).rejects.toThrow(BadRequestException);
  });

  it('successfully updates appointment atomically and creates notifications', async () => {
    const emailOutbox = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const reminders = { cancelForAppointment: vi.fn(), scheduleForAppointment: vi.fn() };
    const scheduleService = {
      ...scheduleServiceWith({ ...availableSchedule, timezone: 'America/New_York' }),
      getTimezoneForDoctor: vi.fn().mockResolvedValue('America/New_York'),
    };
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
