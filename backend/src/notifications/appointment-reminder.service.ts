import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNotNull, lt, lte, or } from 'drizzle-orm';
import { db } from '../db/database.js';
import { appointment, appointmentReminder, user } from '../db/schema.js';
import { EmailService } from './email.service.js';

export const APPOINTMENT_REMINDER_INTERVALS_MINUTES = [1440, 60] as const;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const BATCH_SIZE = 20;

type ReminderTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ReminderAppointment = {
  id: string;
  patientId: string;
  doctorId: string;
  startsAt: Date;
  updatedAt: Date;
  reminderGeneration: number;
};

@Injectable()
export class AppointmentReminderService {
  private readonly logger = new Logger(AppointmentReminderService.name);
  private running = false;
  private warnedTestOnly = false;

  constructor(private readonly emailService: EmailService) {}

  async scheduleForAppointment(
    tx: ReminderTransaction,
    record: ReminderAppointment,
    timezone: string,
    now = new Date(),
  ): Promise<number> {
    if (record.startsAt.getTime() <= now.getTime()) return 0;
    const participants = await tx.select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, [record.patientId, record.doctorId]));
    const byId = new Map(participants.map((participant) => [participant.id, participant]));
    const patient = byId.get(record.patientId);
    const doctor = byId.get(record.doctorId);
    if (!patient || !doctor) return 0;
    let scheduled = 0;

    for (const participant of participants) {
      if (!participant.email.trim()) continue;
      const isPatient = participant.id === record.patientId;
      for (const intervalMinutes of APPOINTMENT_REMINDER_INTERVALS_MINUTES) {
        const scheduledFor = new Date(record.startsAt.getTime() - intervalMinutes * 60_000);
        if (scheduledFor.getTime() <= now.getTime()) continue;
        await tx.insert(appointmentReminder).values({
          id: randomUUID(),
          appointmentId: record.id,
          recipientId: participant.id,
          recipientEmail: participant.email,
          recipientName: participant.name,
          otherPartyName: isPatient ? `Dr. ${doctor.name}` : patient.name,
          intervalMinutes,
          appointmentStartsAt: record.startsAt,
          generation: record.reminderGeneration,
          timezone,
          scheduledFor,
          nextAttemptAt: scheduledFor,
          status: 'pending',
        }).onConflictDoNothing({
          target: [
            appointmentReminder.appointmentId,
            appointmentReminder.recipientId,
            appointmentReminder.intervalMinutes,
            appointmentReminder.generation,
          ],
        });
        scheduled++;
      }
    }
    return scheduled;
  }

  async cancelForAppointment(tx: ReminderTransaction, appointmentId: string): Promise<void> {
    await tx.update(appointmentReminder).set({
      status: 'cancelled',
      processingAt: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(appointmentReminder.appointmentId, appointmentId),
      inArray(appointmentReminder.status, ['pending', 'processing']),
    ));
  }

  @Interval(10_000)
  async dispatchScheduledBatch(): Promise<void> {
    if (this.running) return;
    // Reminders must always use the configured test sink. Production delivery is intentionally disabled.
    if (!this.emailService.isTestMode()) {
      if (!this.warnedTestOnly) {
        this.logger.warn('Appointment reminders paused: delivery is restricted to EMAIL_DELIVERY_MODE=test.');
        this.warnedTestOnly = true;
      }
      return;
    }
    this.running = true;
    try {
      await this.dispatchBatch();
    } catch (error: unknown) {
      this.logger.error(`Appointment reminder batch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.running = false;
    }
  }

  async dispatchBatch(now = new Date()): Promise<number> {
    if (!this.emailService.isTestMode()) return 0;
    await db.update(appointmentReminder).set({
      status: 'dead',
      lastError: 'maximum_attempts_reached_after_worker_crash',
      processingAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(or(
      and(eq(appointmentReminder.status, 'pending'), gte(appointmentReminder.attemptCount, MAX_ATTEMPTS)),
      and(eq(appointmentReminder.status, 'processing'), lte(appointmentReminder.leaseExpiresAt, now), gte(appointmentReminder.attemptCount, MAX_ATTEMPTS)),
    ));

    const claimed = await db.transaction(async (tx) => {
      const rows = await tx.select().from(appointmentReminder).where(or(
        and(
          eq(appointmentReminder.status, 'pending'),
          lte(appointmentReminder.nextAttemptAt, now),
          lte(appointmentReminder.scheduledFor, now),
          lt(appointmentReminder.attemptCount, MAX_ATTEMPTS),
        ),
        and(
          eq(appointmentReminder.status, 'processing'),
          lte(appointmentReminder.leaseExpiresAt, now),
          lt(appointmentReminder.attemptCount, MAX_ATTEMPTS),
        ),
      )).orderBy(asc(appointmentReminder.scheduledFor)).limit(BATCH_SIZE).for('update', { skipLocked: true });

      const result = [];
      for (const row of rows) {
        const [updated] = await tx.update(appointmentReminder).set({
          status: 'processing',
          attemptCount: row.attemptCount + 1,
          firstAttemptAt: row.firstAttemptAt ?? now,
          processingAt: now,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          updatedAt: now,
        }).where(eq(appointmentReminder.id, row.id)).returning();
        if (updated) result.push(updated);
      }
      return result;
    });

    for (const row of claimed) await this.deliver(row.id, now);
    return claimed.length;
  }

  @Interval(24 * 60 * 60 * 1000)
  async purgeExpiredRecords(): Promise<void> {
    const now = Date.now();
    const sentCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const inactiveCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000);
    try {
      await db.delete(appointmentReminder).where(or(
        and(eq(appointmentReminder.status, 'sent'), isNotNull(appointmentReminder.sentAt), lt(appointmentReminder.sentAt, sentCutoff)),
        and(inArray(appointmentReminder.status, ['cancelled', 'dead']), lt(appointmentReminder.updatedAt, inactiveCutoff)),
      ));
    } catch (error: unknown) {
      this.logger.error(`Appointment reminder retention cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async deliver(reminderId: string, now = new Date()): Promise<void> {
    // Lock the appointment before checking/sending so cancellation and rescheduling serialize
    // with delivery. Provider idempotency covers a crash after acceptance but before commit.
    await db.transaction(async (tx) => {
      const [claimed] = await tx.select().from(appointmentReminder)
        .where(eq(appointmentReminder.id, reminderId)).limit(1);
      if (!claimed || claimed.status !== 'processing') return;

      const [appt] = await tx.select({
        id: appointment.id,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        startsAt: appointment.startsAt,
        updatedAt: appointment.updatedAt,
        reminderGeneration: appointment.reminderGeneration,
        status: appointment.status,
      }).from(appointment).where(eq(appointment.id, claimed.appointmentId))
        .for('update').limit(1);

      const [currentReminder] = await tx.select().from(appointmentReminder)
        .where(eq(appointmentReminder.id, claimed.id)).for('update').limit(1);
      if (!currentReminder || currentReminder.status !== 'processing') return;
      const checkedAt = new Date();

      if (!appt || appt.status !== 'scheduled' || appt.startsAt.getTime() <= checkedAt.getTime() ||
        appt.startsAt.getTime() !== currentReminder.appointmentStartsAt.getTime() ||
        appt.reminderGeneration !== currentReminder.generation ||
        (currentReminder.recipientId !== appt.patientId && currentReminder.recipientId !== appt.doctorId)) {
        await tx.update(appointmentReminder).set({
          status: 'cancelled', lastError: 'appointment_or_schedule_no_longer_eligible',
          processingAt: null, leaseExpiresAt: null, updatedAt: now,
        }).where(eq(appointmentReminder.id, currentReminder.id));
        return;
      }

      const [recipient] = await tx.select({ id: user.id, email: user.email })
        .from(user).where(eq(user.id, currentReminder.recipientId)).limit(1);
      const otherPartyId = currentReminder.recipientId === appt.patientId ? appt.doctorId : appt.patientId;
      const [otherParty] = await tx.select({ id: user.id }).from(user)
        .where(eq(user.id, otherPartyId)).limit(1);
      if (!recipient || !otherParty || recipient.email !== currentReminder.recipientEmail) {
        await tx.update(appointmentReminder).set({
          status: 'cancelled', lastError: recipient && recipient.email !== currentReminder.recipientEmail
            ? 'recipient_email_changed_since_scheduling'
            : 'appointment_participant_unavailable',
          processingAt: null, leaseExpiresAt: null, updatedAt: now,
        }).where(eq(appointmentReminder.id, currentReminder.id));
        return;
      }

      const result = await this.emailService.sendEvent('appointment_reminder', currentReminder.recipientEmail, {
        recipientName: currentReminder.recipientName,
        otherPartyName: currentReminder.otherPartyName,
        startsAt: appt.startsAt.toISOString(),
        timezone: currentReminder.timezone,
        intervalMinutes: currentReminder.intervalMinutes,
      }, `appointment_reminder:${currentReminder.id}`);

      if (result.status === 'sent') {
        await tx.update(appointmentReminder).set({
          status: 'sent', sentAt: new Date(), lastError: null,
          processingAt: null, leaseExpiresAt: null, updatedAt: new Date(),
        }).where(eq(appointmentReminder.id, currentReminder.id));
        return;
      }

      if (result.status === 'disabled') {
        await tx.update(appointmentReminder).set({
          status: 'pending', attemptCount: Math.max(0, currentReminder.attemptCount - 1),
          nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
          lastError: 'delivery_disabled_missing_configuration',
          processingAt: null, leaseExpiresAt: null, updatedAt: new Date(),
        }).where(eq(appointmentReminder.id, currentReminder.id));
        return;
      }

      if (result.status === 'permanent_failure' || currentReminder.attemptCount >= MAX_ATTEMPTS) {
        await tx.update(appointmentReminder).set({
          status: 'dead', lastError: result.reason.slice(0, 300),
          processingAt: null, leaseExpiresAt: null, updatedAt: new Date(),
        }).where(eq(appointmentReminder.id, currentReminder.id));
        return;
      }

      const delay = Math.min(30_000 * (2 ** (currentReminder.attemptCount - 1)), MAX_BACKOFF_MS);
      await tx.update(appointmentReminder).set({
        status: 'pending',
        nextAttemptAt: new Date(Date.now() + delay),
        lastError: result.ambiguous ? `${result.reason}; provider_acceptance_unknown` : result.reason,
        processingAt: null, leaseExpiresAt: null, updatedAt: new Date(),
      }).where(eq(appointmentReminder.id, currentReminder.id));
    });
  }
}
