import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NotificationRecord, NotificationType } from './notifications.schema.js';
import { EmailService } from './email.service.js';

export interface CreateNotificationParams {
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  appointmentId?: string | null;
  scheduleRequestId?: string | null;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly emailService: EmailService) {}

  // In-memory persistent collection keyed by userId
  private readonly userNotifications = new Map<string, NotificationRecord[]>();

  async createNotification(params: CreateNotificationParams): Promise<NotificationRecord> {
    const record: NotificationRecord = {
      id: randomUUID(),
      userId: params.userId,
      title: params.title,
      message: params.message,
      type: params.type,
      read: false,
      appointmentId: params.appointmentId ?? null,
      scheduleRequestId: params.scheduleRequestId ?? null,
      createdAt: new Date().toISOString(),
    };

    const currentList = this.userNotifications.get(params.userId) ?? [];
    const duplicate = currentList.find((item) =>
      !item.read &&
      item.type === params.type &&
      item.appointmentId === (params.appointmentId ?? null) &&
      item.scheduleRequestId === (params.scheduleRequestId ?? null) &&
      item.title === params.title);
    if (duplicate) return duplicate;
    // Prepend new notification
    currentList.unshift(record);
    // Keep max 100 recent notifications per user
    if (currentList.length > 100) {
      currentList.length = 100;
    }
    this.userNotifications.set(params.userId, currentList);

    return record;
  }

  async listForUser(userId: string): Promise<NotificationRecord[]> {
    return this.userNotifications.get(userId) ?? [];
  }

  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const list = this.userNotifications.get(userId) ?? [];
    const count = list.filter((n) => !n.read).length;
    return { count };
  }

  async markAsRead(id: string, userId: string): Promise<NotificationRecord> {
    const list = this.userNotifications.get(userId) ?? [];
    const item = list.find((n) => n.id === id);
    if (!item) {
      throw new NotFoundException('Notification not found.');
    }
    item.read = true;
    return item;
  }

  async markAllAsRead(userId: string): Promise<{ updatedCount: number }> {
    const list = this.userNotifications.get(userId) ?? [];
    let count = 0;
    for (const item of list) {
      if (!item.read) {
        item.read = true;
        count++;
      }
    }
    return { updatedCount: count };
  }

  getEmailService(): EmailService {
    return this.emailService;
  }
}
