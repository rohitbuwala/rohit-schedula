import { BadRequestException, Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { patientProfileUpdateSchema } from './patient-profile.schema.js';
import { PatientsService } from './patients.service.js';

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
    const parsed = patientProfileUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.patients.updateOwn(patient.id, parsed.data);
  }
}
