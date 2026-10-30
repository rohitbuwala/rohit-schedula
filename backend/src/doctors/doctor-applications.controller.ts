import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { doctorAdminListQuerySchema, doctorApplicationSchema, doctorDecisionSchema } from './doctor-profile.schema.js';
import { DoctorProfilesService } from './doctor-profiles.service.js';

const idSchema = z.uuid();

@Controller('api/doctor-applications')
@UseGuards(AuthSessionGuard, RolesGuard)
export class DoctorApplicationsController {
  constructor(private readonly profiles: DoctorProfilesService) {}

  @Post()
  @Roles('patient')
  apply(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = doctorApplicationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.profiles.apply(user.id, parsed.data);
  }

  @Get('me')
  @Roles('patient')
  getMine(@CurrentUser() user: AuthenticatedUser) {
    return this.profiles.getApplicationForApplicant(user.id);
  }
}

@Controller('api/admin/doctor-applications')
@UseGuards(AuthSessionGuard, RolesGuard)
@Roles('admin')
export class AdminDoctorApplicationsController {
  constructor(private readonly profiles: DoctorProfilesService) {}

  @Get()
  list(@Query('status') status: string | undefined) {
    const parsed = doctorAdminListQuerySchema.optional().safeParse(status);
    if (!parsed.success) throw new BadRequestException('Invalid application status.');
    return this.profiles.listApplications(parsed.data ?? 'pending');
  }

  @Patch(':id/decision')
  decide(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser, @Body() body: unknown) {
    const parsedId = idSchema.safeParse(id);
    const parsedBody = doctorDecisionSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) throw new BadRequestException('Invalid application decision.');
    return this.profiles.decide(parsedId.data, admin.id, parsedBody.data.decision);
  }

  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestException('Invalid doctor profile id.');
    return this.profiles.deactivateDoctor(parsedId.data, admin.id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestException('Invalid doctor profile id.');
    return this.profiles.deleteDoctor(parsedId.data);
  }
}

@Controller('api/admin/doctors')
@UseGuards(AuthSessionGuard, RolesGuard)
@Roles('admin')
export class AdminDoctorsController {
  constructor(private readonly profiles: DoctorProfilesService) {}

  @Get()
  list(@Query('status') status: string | undefined) {
    const parsed = doctorAdminListQuerySchema.optional().safeParse(status);
    if (!parsed.success) throw new BadRequestException('Invalid doctor status query.');
    return this.profiles.listApplications(parsed.data ?? 'approved');
  }

  @Patch(':id/decision')
  decide(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser, @Body() body: unknown) {
    const parsedId = idSchema.safeParse(id);
    const parsedBody = doctorDecisionSchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) throw new BadRequestException('Invalid decision body.');
    return this.profiles.decide(parsedId.data, admin.id, parsedBody.data.decision);
  }

  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestException('Invalid doctor profile id.');
    return this.profiles.deactivateDoctor(parsedId.data, admin.id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestException('Invalid doctor profile id.');
    return this.profiles.deleteDoctor(parsedId.data);
  }
}
