import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DoctorsModule } from '../doctors/doctors.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { AppointmentExpiryService } from './appointment-expiry.service.js';

@Module({
  imports: [AuthModule, DoctorsModule, NotificationsModule, PaymentsModule],
  controllers: [AppointmentsController],
  providers: [AuthSessionGuard, RolesGuard, AppointmentsService, AppointmentExpiryService],
  exports: [AppointmentsService, AppointmentExpiryService],
})
export class AppointmentsModule {}
