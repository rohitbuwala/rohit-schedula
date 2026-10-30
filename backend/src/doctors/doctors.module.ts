import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminDoctorApplicationsController, AdminDoctorsController, DoctorApplicationsController } from './doctor-applications.controller.js';
import { DoctorApprovedGuard } from './doctor-approved.guard.js';
import { DoctorsController } from './doctors.controller.js';
import { DoctorProfilesService } from './doctor-profiles.service.js';
import { DoctorScheduleController } from './doctor-schedule.controller.js';
import { DoctorScheduleService } from './doctor-schedule.service.js';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [
    DoctorsController,
    DoctorApplicationsController,
    AdminDoctorApplicationsController,
    AdminDoctorsController,
    DoctorScheduleController,
  ],
  providers: [
    AuthSessionGuard,
    RolesGuard,
    DoctorProfilesService,
    DoctorApprovedGuard,
    DoctorScheduleService,
  ],
  exports: [DoctorProfilesService, DoctorApprovedGuard, DoctorScheduleService],
})
export class DoctorsModule {}
