import { NotificationsService } from './notifications.service.js';
import { EmailService } from './email.service.js';

describe('notifications service', () => {
  let service: NotificationsService;
  const userA = 'patient-1';
  const userB = 'doctor-2';

  beforeEach(() => {
    const emailService = new EmailService();
    service = new NotificationsService(emailService);
  });

  it('creates notifications and tracks unread count', async () => {
    const initial = await service.getUnreadCount(userA);
    expect(initial.count).toBe(0);

    await service.createNotification({
      userId: userA,
      title: 'Appointment Booked',
      message: 'Your appointment is confirmed.',
      type: 'booking',
    });

    const unread = await service.getUnreadCount(userA);
    expect(unread.count).toBe(1);

    const list = await service.listForUser(userA);
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe('Appointment Booked');
    expect(list[0]?.read).toBe(false);
  });

  it('isolates notifications between users', async () => {
    await service.createNotification({
      userId: userA,
      title: 'User A Notice',
      message: 'Private message for A',
      type: 'system',
    });

    await service.createNotification({
      userId: userB,
      title: 'User B Notice',
      message: 'Private message for B',
      type: 'system',
    });

    const listA = await service.listForUser(userA);
    const listB = await service.listForUser(userB);

    expect(listA).toHaveLength(1);
    expect(listA[0]?.title).toBe('User A Notice');

    expect(listB).toHaveLength(1);
    expect(listB[0]?.title).toBe('User B Notice');
  });

  it('marks a single notification as read', async () => {
    const note = await service.createNotification({
      userId: userA,
      title: 'Reminder',
      message: 'Upcoming visit tomorrow',
      type: 'reminder',
    });

    await service.markAsRead(note.id, userA);
    const unread = await service.getUnreadCount(userA);
    expect(unread.count).toBe(0);

    const list = await service.listForUser(userA);
    expect(list[0]?.read).toBe(true);
  });

  it('marks all notifications as read', async () => {
    await service.createNotification({ userId: userA, title: 'N1', message: 'M1', type: 'system' });
    await service.createNotification({ userId: userA, title: 'N2', message: 'M2', type: 'system' });

    expect((await service.getUnreadCount(userA)).count).toBe(2);
    const result = await service.markAllAsRead(userA);
    expect(result.updatedCount).toBe(2);
    expect((await service.getUnreadCount(userA)).count).toBe(0);
  });
});
