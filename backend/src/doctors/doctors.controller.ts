import { BadRequestException, Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DoctorApprovedGuard } from './doctor-approved.guard.js';
import { DoctorProfilesService } from './doctor-profiles.service.js';
import { doctorProfileUpdateSchema } from './doctor-profile.schema.js';

const idSchema = z.uuid();

@Controller('api/doctors')
export class DoctorsController {
  constructor(private readonly profiles: DoctorProfilesService) {}

  @Get()
  listPublic() {
    return this.profiles.listPublicProfiles();
  }

  @Get('me')
  @Roles('doctor')
  @UseGuards(AuthSessionGuard, RolesGuard, DoctorApprovedGuard)
  getOwn(@CurrentUser() user: AuthenticatedUser) {
    return this.profiles.getOwnApprovedProfile(user.id);
  }

  @Patch('me')
  @Roles('doctor')
  @UseGuards(AuthSessionGuard, RolesGuard, DoctorApprovedGuard)
  updateOwn(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = doctorProfileUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.profiles.updateOwnApprovedProfile(user.id, parsed.data);
  }

  @Get(':id')
  getPublic(@Param('id') id: string) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestException('Invalid doctor profile id.');
    return this.profiles.getPublicProfile(parsed.data);
  }
}
