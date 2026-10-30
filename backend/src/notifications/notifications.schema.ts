import { z } from 'zod';

export const notificationTypeEnum = z.enum([
  'booking',
  'reschedule',
  'cancellation',
  'completion',
  'reminder',
  'system',
]);

export type NotificationType = z.infer<typeof notificationTypeEnum>;

export interface NotificationRecord {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  read: boolean;
  appointmentId?: string | null;
  createdAt: string;
}
