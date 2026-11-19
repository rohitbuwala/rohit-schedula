import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db/database.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';

vi.mock('../db/database.js', () => ({ db: { select: vi.fn() } }));

describe('doctor appointment patient profile', () => {
  const doctors = { isApproved: vi.fn() };
  const service = new AppointmentsService(doctors as never);
  let where: ReturnType<typeof vi.fn>;
  let limit: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    doctors.isApproved.mockResolvedValue(true);
    limit = vi.fn();
    where = vi.fn().mockReturnValue({ limit });
    vi.mocked(db.select).mockReturnValue({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where }) }) }) } as never);
  });

  it('requires a doctor role and an authenticated user', () => {
    const guard = new RolesGuard(new Reflector());
    for (const authUser of [undefined, { id: 'p1', role: 'patient' }, { id: 's1', role: 'staff' }, { id: 'a1', role: 'admin' }]) {
      const context = { getHandler: () => AppointmentsController.prototype.getPatient, getClass: () => AppointmentsController,
        switchToHttp: () => ({ getRequest: () => ({ authUser }) }) } as unknown as ExecutionContext;
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    }
  });

  it('denies an unapproved doctor before querying patient data', async () => {
    doctors.isApproved.mockResolvedValue(false);
    await expect(service.getPatientForDoctorAppointment('appointment-1', 'doctor-1')).rejects.toThrow(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('queries only the authenticated doctor appointment with scheduled or completed status', async () => {
    const profile = { id: 'patient-1', name: 'Patient', dateOfBirth: null, gender: null, bloodGroup: null, phone: null, address: null, allergies: null };
    limit.mockResolvedValue([profile]);
    await expect(service.getPatientForDoctorAppointment('appointment-1', 'doctor-1')).resolves.toEqual(profile);
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.params).toEqual(expect.arrayContaining(['appointment-1', 'doctor-1', 'scheduled', 'completed']));
    expect(query.params).not.toContain('cancelled');
    expect(query.params).not.toContain('pending_payment');
    expect(query.sql).toContain('"appointment"."doctor_id"');
    expect(query.sql).toContain('"appointment"."status"');
  });

  it('returns not found when the appointment is another doctor’s, missing, cancelled or pending payment', async () => {
    limit.mockResolvedValue([]);
    await expect(service.getPatientForDoctorAppointment('appointment-1', 'doctor-2')).rejects.toThrow(NotFoundException);
  });
});
