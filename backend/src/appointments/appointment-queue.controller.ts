import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AppointmentQueueService } from './appointment-queue.service.js';
import { ownQueueReadSchema, queueAppointmentIdSchema, queueCheckInBodySchema, queueReadSchema, queueNextSchema, queueNoShowSchema } from './appointment-queue.schema.js';
import { staffUserIdSchema } from '../auth/staff-access.schema.js';

@Controller('api')
@UseGuards(AuthSessionGuard, RolesGuard)
export class AppointmentQueueController {
  constructor(private readonly queue: AppointmentQueueService) {}

  @Post('queues/:doctorId/next')
  @HttpCode(200)
  @Roles('doctor')
  @Header('Cache-Control', 'no-store')
  next(@CurrentUser() actor: AuthenticatedUser, @Param('doctorId') doctorId: string, @Body() body: unknown) {
    const parsedId = staffUserIdSchema.safeParse(doctorId), parsed = queueNextSchema.safeParse(body);
    if (!parsedId.success || !parsed.success) throw new BadRequestException({ code: 'QUEUE_INVALID_NEXT', message: 'Provide a doctor, service date and expected queue version.' });
    return this.queue.next(actor, parsedId.data, parsed.data);
  }

  @Post('appointments/:id/no-show')
  @HttpCode(200)
  @Roles('doctor', 'staff')
  @Header('Cache-Control', 'no-store')
  noShow(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const parsedId = queueAppointmentIdSchema.safeParse(id), parsed = queueNoShowSchema.safeParse(body ?? {});
    if (!parsedId.success || !parsed.success) throw new BadRequestException({ code: 'QUEUE_INVALID_NO_SHOW', message: 'Provide a valid appointment identifier and attendance version.' });
    return this.queue.noShow(actor, parsedId.data, parsed.data);
  }

  @Post('appointments/:id/check-in')
  @HttpCode(200)
  @Roles('doctor', 'staff')
  @Header('Cache-Control', 'no-store')
  checkIn(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const parsed = queueAppointmentIdSchema.safeParse(id);
    if (!parsed.success || !queueCheckInBodySchema.safeParse(body ?? {}).success) throw new BadRequestException({ code: 'QUEUE_INVALID_CHECK_IN', message: 'Provide a valid appointment identifier and an empty body.' });
    return this.queue.checkIn(actor, parsed.data);
  }

  @Get('queues/mine')
  @Roles('patient')
  @Header('Cache-Control', 'no-store')
  mine(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) {
    const parsed = ownQueueReadSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ code: 'QUEUE_INVALID_APPOINTMENTS', message: 'Provide up to 50 unique appointment identifiers.' });
    return this.queue.ownAttendance(actor, parsed.data.appointmentIds);
  }

  @Get('queues/assignments')
  @Roles('doctor', 'staff')
  @Header('Cache-Control', 'no-store')
  assignments(@CurrentUser() actor: AuthenticatedUser) { return this.queue.assignments(actor); }

  @Get('queues')
  @Roles('doctor', 'staff')
  @Header('Cache-Control', 'no-store')
  read(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) {
    const parsed = queueReadSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ code: 'QUEUE_INVALID_QUERY', message: 'Provide a doctor, valid service date and bounded pagination.' });
    return this.queue.read(actor, parsed.data);
  }
}
