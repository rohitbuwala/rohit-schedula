import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AppointmentQueueLifecycleService } from './appointment-queue-lifecycle.service.js';

@Module({ imports: [NotificationsModule], providers: [AppointmentQueueLifecycleService], exports: [AppointmentQueueLifecycleService] })
export class AppointmentQueueLifecycleModule {}
