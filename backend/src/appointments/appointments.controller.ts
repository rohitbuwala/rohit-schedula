import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DoctorApprovedGuard } from '../doctors/doctor-approved.guard.js';
import { AppointmentsService } from './appointments.service.js';
import { appointmentBookingSchema } from './appointment-booking.schema.js';
import { appointmentAvailabilityQuerySchema } from './appointment-availability.schema.js';

const idSchema = z.uuid();

@Controller('api/appointments')
@UseGuards(AuthSessionGuard, RolesGuard)
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Post()
  @Roles('patient')
  create(@CurrentUser() patient: AuthenticatedUser, @Body() body: unknown) {
    const parsed = appointmentBookingSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.appointments.createForPatient(patient.id, parsed.data);
  }

  @Get('availability')
  @Roles('patient')
  availability(@CurrentUser() patient: AuthenticatedUser, @Query() query: unknown) {
    const parsed = appointmentAvailabilityQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.appointments.getAvailableSlots(patient.id, parsed.data);
  }

  @Get('me')
  @Roles('patient', 'doctor')
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.appointments.listMine(user);
  }

  @Get(':id/patient')
  @Roles('doctor')
  @UseGuards(DoctorApprovedGuard)
  getPatient(@Param('id') id: string, @CurrentUser() doctor: AuthenticatedUser) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestException('Invalid appointment id.');
    return this.appointments.getPatientForDoctorAppointment(parsed.data, doctor.id);
  }

  @Get(':id')
  @Roles('patient', 'doctor')
  getMine(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestException('Invalid appointment id.');
    return this.appointments.getMine(parsed.data, user);
  }
}
