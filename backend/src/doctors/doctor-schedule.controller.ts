import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DoctorApprovedGuard } from './doctor-approved.guard.js';
import { DoctorScheduleService } from './doctor-schedule.service.js';
import {
  doctorScheduleUpdateSchema,
  doctorLeaveInputSchema,
  doctorScheduleOverrideInputSchema,
} from './doctor-schedule.schema.js';

@Controller('api/doctor/schedule')
@UseGuards(AuthSessionGuard, RolesGuard, DoctorApprovedGuard)
@Roles('doctor')
export class DoctorScheduleController {
  constructor(private readonly scheduleService: DoctorScheduleService) {}

  @Get()
  getSchedule(@CurrentUser() doctor: AuthenticatedUser) {
    return this.scheduleService.getSchedule(doctor.id);
  }

  @Put()
  updateSchedule(@CurrentUser() doctor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = doctorScheduleUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.scheduleService.updateSchedule(doctor.id, parsed.data);
  }

  @Post('conflicts')
  checkConflicts(@CurrentUser() doctor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = doctorScheduleUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.scheduleService.checkConflicts(doctor.id, parsed.data);
  }

  @Post('leave')
  addLeave(@CurrentUser() doctor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = doctorLeaveInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.scheduleService.addLeave(doctor.id, parsed.data);
  }

  @Delete('leave/:id')
  async removeLeave(@CurrentUser() doctor: AuthenticatedUser, @Param('id') id: string) {
    await this.scheduleService.removeLeave(doctor.id, id);
    return { success: true };
  }

  @Put('override')
  upsertOverride(@CurrentUser() doctor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = doctorScheduleOverrideInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.scheduleService.upsertOverride(doctor.id, parsed.data);
  }

  @Delete('override/:date')
  async removeOverride(@CurrentUser() doctor: AuthenticatedUser, @Param('date') date: string) {
    const parsed = doctorScheduleOverrideInputSchema.shape.date.safeParse(date);
    if (!parsed.success) throw new BadRequestException('Invalid override date.');
    await this.scheduleService.removeOverride(doctor.id, parsed.data);
    return { success: true };
  }
}
