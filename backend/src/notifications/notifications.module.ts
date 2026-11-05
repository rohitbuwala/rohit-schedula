import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { EmailService } from './email.service.js';
import { EmailOutboxService } from './email-outbox.service.js';
import { AppointmentReminderService } from './appointment-reminder.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [AuthSessionGuard, EmailService, EmailOutboxService, AppointmentReminderService, NotificationsService],
  exports: [NotificationsService, EmailService, EmailOutboxService, AppointmentReminderService],
})
export class NotificationsModule {}
