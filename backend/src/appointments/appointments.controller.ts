import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DoctorApprovedGuard } from '../doctors/doctor-approved.guard.js';
import { AppointmentsService } from './appointments.service.js';
import { appointmentBookingReplaySchema, appointmentBookingSchema } from './appointment-booking.schema.js';
import { appointmentAvailabilityQuerySchema } from './appointment-availability.schema.js';
import { appointmentRescheduleSchema } from './appointment-reschedule.schema.js';

const idSchema = z.uuid();

@Controller('api/appointments')
@UseGuards(AuthSessionGuard, RolesGuard)
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Post()
  @Roles('patient')
  create(@CurrentUser() patient: AuthenticatedUser, @Body() body: unknown, @Headers('idempotency-key') key?: string,
    @Headers('x-booking-patient') expectedPatient?: string) {
    if (expectedPatient !== undefined && expectedPatient !== patient.id) throw new ForbiddenException('The booking session changed.');
    if (key !== undefined && !z.uuid().safeParse(key).success) throw new BadRequestException('Invalid idempotency key.');
    const parsed = (key ? appointmentBookingReplaySchema : appointmentBookingSchema).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return key ? this.appointments.createForPatient(patient.id, parsed.data, key) : this.appointments.createForPatient(patient.id, parsed.data);
  }

  @Get(':id/hold')
  @Roles('patient')
  @Header('Cache-Control', 'no-store')
  recoverHold(@CurrentUser() patient: AuthenticatedUser, @Param('id') id: string) {
    if (!idSchema.safeParse(id).success) throw new BadRequestException('Invalid appointment id.');
    return this.appointments.recoverPatientHold(patient.id, id);
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

  @Get('schedule-requests')
  @Roles('patient')
  listScheduleChangeRequests(@CurrentUser() patient: AuthenticatedUser) {
    return this.appointments.listScheduleChangeRequestsForPatient(patient.id);
  }

  @Get('schedule-requests/:requestId')
  @Roles('patient')
  getScheduleChangeRequest(
    @Param('requestId') requestId: string,
    @CurrentUser() patient: AuthenticatedUser,
  ) {
    const parsed = idSchema.safeParse(requestId);
    if (!parsed.success) throw new BadRequestException('Invalid schedule request id.');
    return this.appointments.getScheduleChangeRequestForPatient(parsed.data, patient.id);
  }

  @Post('schedule-requests/:requestId/appointments/:affectedAppointmentId/accept')
  @Roles('patient')
  acceptScheduleChange(
    @Param('requestId') requestId: string,
    @Param('affectedAppointmentId') affectedAppointmentId: string,
    @CurrentUser() patient: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    const parsedRequestId = idSchema.safeParse(requestId);
    const parsedAffectedId = idSchema.safeParse(affectedAppointmentId);
    if (!parsedRequestId.success || !parsedAffectedId.success) {
      throw new BadRequestException('Invalid schedule change identifier.');
    }
    const parsedBody = z.object({ alternativeId: idSchema }).strict().safeParse(body);
    if (!parsedBody.success) throw new BadRequestException(parsedBody.error.flatten());
    return this.appointments.acceptScheduleChange(
      parsedRequestId.data,
      parsedAffectedId.data,
      parsedBody.data.alternativeId,
      patient.id,
    );
  }

  @Post('schedule-requests/:requestId/appointments/:affectedAppointmentId/decline')
  @Roles('patient')
  declineScheduleChange(
    @Param('requestId') requestId: string,
    @Param('affectedAppointmentId') affectedAppointmentId: string,
    @CurrentUser() patient: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    const parsedRequestId = idSchema.safeParse(requestId);
    const parsedAffectedId = idSchema.safeParse(affectedAppointmentId);
    if (!parsedRequestId.success || !parsedAffectedId.success) {
      throw new BadRequestException('Invalid schedule change identifier.');
    }

    const parsedBody = z.object({ reason: z.string().trim().max(500).optional() }).strict().safeParse(body ?? {});
    if (!parsedBody.success) throw new BadRequestException(parsedBody.error.flatten());
    return this.appointments.declineScheduleChange(
      parsedRequestId.data,
      parsedAffectedId.data,
      patient.id,
      parsedBody.data.reason,
    );
  }

  @Post('schedule-requests/:requestId/appointments/:affectedAppointmentId/cancel')
  @Roles('doctor')
  cancelUnresolvedScheduleChange(
    @Param('requestId') requestId: string,
    @Param('affectedAppointmentId') affectedAppointmentId: string,
    @CurrentUser() doctor: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    const parsedRequestId = idSchema.safeParse(requestId);
    const parsedAffectedId = idSchema.safeParse(affectedAppointmentId);
    const parsedBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict().safeParse(body);
    if (!parsedRequestId.success || !parsedAffectedId.success || !parsedBody.success) {
      throw new BadRequestException('A valid cancellation reason is required.');
    }
    return this.appointments.cancelUnresolvedScheduleChange(
      parsedRequestId.data,
      parsedAffectedId.data,
      doctor.id,
      parsedBody.data.reason,
    );
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

  @Patch(':id/cancel')
  @Roles('patient', 'doctor')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestException('Invalid appointment id.');
    return this.appointments.cancel(parsed.data, user);
  }

  @Patch(':id/reschedule')
  @Roles('patient', 'doctor')
  reschedule(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestException('Invalid appointment id.');
    const parsedBody = appointmentRescheduleSchema.safeParse(body);
    if (!parsedBody.success) throw new BadRequestException(parsedBody.error.flatten());
    return this.appointments.reschedule(parsedId.data, user, parsedBody.data);
  }

  @Patch(':id/complete')
  @Roles('doctor')
  @UseGuards(DoctorApprovedGuard)
  complete(@Param('id') id: string, @CurrentUser() doctor: AuthenticatedUser) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestException('Invalid appointment id.');
    return this.appointments.complete(parsed.data, doctor);
  }
}
