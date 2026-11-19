import { BadRequestException, Body, Controller, Get, Header, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { patientProfileUpdateSchema } from './patient-profile.schema.js';
import { PatientsService } from './patients.service.js';

const medicalInput = z.object({
  allergies: z.string().trim().max(500).nullable().transform(value => value || null),
  conditions: z.string().trim().max(500).nullable().transform(value => value || null),
  revision: z.number().int().nonnegative(),
}).strict();
const appointmentIdSchema = z.uuid();

@Controller('api/patients')
@UseGuards(AuthSessionGuard, RolesGuard)
@Roles('patient')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get('me')
  getOwn(@CurrentUser() patient: AuthenticatedUser) {
    return this.patients.getOwn(patient.id);
  }

  @Patch('me')
  updateOwn(@CurrentUser() patient: AuthenticatedUser, @Body() body: unknown) {
    const revisionField = z.object({ medicalRevision: z.number().int().nonnegative().optional() }).passthrough().safeParse(body);
    if (!revisionField.success) throw new BadRequestException('Invalid medical revision.');
    const { medicalRevision, ...profile } = revisionField.data;
    const parsed = patientProfileUpdateSchema.safeParse(profile);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return medicalRevision === undefined ? this.patients.updateOwn(patient.id, parsed.data) : this.patients.updateOwn(patient.id, parsed.data, medicalRevision);
  }

  @Get('me/medical')
  @Header('Cache-Control', 'no-store')
  medicalOwn(@CurrentUser() patient: AuthenticatedUser) { return this.patients.getMedical(patient); }

  @Patch('me/medical')
  @Header('Cache-Control', 'no-store')
  updateMedicalOwn(@CurrentUser() patient: AuthenticatedUser, @Body() body: unknown) {
    const parsed = medicalInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.patients.updateMedical(patient, parsed.data);
  }

  @Get('appointments/:id/medical')
  @Roles('doctor')
  @Header('Cache-Control', 'no-store')
  medicalForDoctor(@CurrentUser() doctor: AuthenticatedUser, @Param('id') id: string) {
    if (!appointmentIdSchema.safeParse(id).success) throw new BadRequestException('Invalid appointment id.');
    return this.patients.getMedical(doctor, id);
  }

  @Patch('appointments/:id/medical')
  @Roles('doctor')
  @Header('Cache-Control', 'no-store')
  updateMedicalForDoctor(@CurrentUser() doctor: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    if (!appointmentIdSchema.safeParse(id).success) throw new BadRequestException('Invalid appointment id.');
    const parsed = medicalInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.patients.updateMedical(doctor, parsed.data, id);
  }
}
