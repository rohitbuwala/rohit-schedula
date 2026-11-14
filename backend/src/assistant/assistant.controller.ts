import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { assistantCancellationSchema, assistantRescheduleSchema, chatRequestSchema } from './assistant.schema.js';
import { AssistantService } from './assistant.service.js';

@Controller('api/assistant')
@UseGuards(AuthSessionGuard, RolesGuard)
@Roles('patient', 'doctor')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('chat')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  chat(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Provide a message between 1 and 1000 characters.');
    return this.assistant.chat(actor, parsed.data.message);
  }

  @Patch('appointments/cancel')
  @Roles('patient')
  @Header('Cache-Control', 'no-store')
  cancel(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = assistantCancellationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Select an appointment and reason, then confirm cancellation.');
    return this.assistant.cancelAppointment(actor, parsed.data.appointmentId, parsed.data.reason);
  }

  @Get('appointments/:id/reschedule-options')
  @Roles('patient')
  @Header('Cache-Control', 'no-store')
  rescheduleOptions(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException('Select an appointment.');
    return this.assistant.rescheduleOptions(actor, id);
  }

  @Patch('appointments/reschedule')
  @Roles('patient')
  @Header('Cache-Control', 'no-store')
  reschedule(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = assistantRescheduleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Select a valid future slot and confirm rescheduling.');
    return this.assistant.rescheduleAppointment(actor, parsed.data);
  }
}
