import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AdminDoctorApplicationsController, DoctorApplicationsController } from './doctor-applications.controller.js';
import { DoctorApprovedGuard } from './doctor-approved.guard.js';
import { DoctorsController } from './doctors.controller.js';
import { DoctorProfilesService } from './doctor-profiles.service.js';

@Module({
  imports: [AuthModule],
  controllers: [DoctorsController, DoctorApplicationsController, AdminDoctorApplicationsController],
  providers: [AuthSessionGuard, RolesGuard, DoctorProfilesService, DoctorApprovedGuard],
  exports: [DoctorProfilesService, DoctorApprovedGuard],
})
export class DoctorsModule {}
