import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, isNotNull, lt, lte, or } from 'drizzle-orm';
import { db } from '../db/database.js';
import { emailOutbox } from '../db/schema.js';
import { EmailService } from './email.service.js';
import type { EmailEventPayload, EmailEventType } from './email-templates.js';

export type OutboxTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EnqueueOptions = {
  eventKey: string;
  eventType: EmailEventType;
  recipient: string;
  payload: EmailEventPayload;
  appointmentId?: string;
  paymentId?: string;
  refundId?: string;
};

const MAX_ATTEMPTS = 8;
const MAX_AUTOMATIC_RETRY_AGE_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const BATCH_SIZE = 10;

export const emailEventKey = {
  booking: (appointmentId: string, recipientId: string) => `booking_confirmation:${appointmentId}:${recipientId}`,
  receipt: (paymentId: string, patientId: string) => `payment_receipt:${paymentId}:${patientId}`,
  refundProcessed: (refundId: string, patientId: string) => `refund_processed:${refundId}:${patientId}`,
  appointment: (type: 'appointment_cancelled' | 'appointment_rescheduled', appointmentId: string, eventId: string, recipientId: string) => `${type}:${appointmentId}:${eventId}:${recipientId}`,
};

@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);
  private running = false;
  private warnedDisabled = false;

  constructor(private readonly emailService: EmailService) {}

  async enqueue(tx: OutboxTransaction, options: EnqueueOptions): Promise<void> {
    await tx.insert(emailOutbox).values({
      id: randomUUID(),
      eventKey: options.eventKey,
      eventType: options.eventType,
      recipient: options.recipient,
      payload: options.payload as unknown as Record<string, unknown>,
      appointmentId: options.appointmentId,
      paymentId: options.paymentId,
      refundId: options.refundId,
      status: 'pending',
      nextAttemptAt: new Date(),
    }).onConflictDoNothing({ target: emailOutbox.eventKey });
  }

  @Interval(10_000)
  async dispatchScheduledBatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.emailService.isConfigured()) {
        if (!this.warnedDisabled) {
          this.logger.warn('Email outbox paused: delivery is disabled until RESEND_API_KEY and EMAIL_FROM are configured.');
          this.warnedDisabled = true;
        }
        const now = new Date();
        await db.update(emailOutbox).set({
          nextAttemptAt: new Date(now.getTime() + 60 * 60 * 1000),
          updatedAt: now,
        }).where(and(eq(emailOutbox.status, 'pending'), lte(emailOutbox.nextAttemptAt, now)));
        return;
      }
      await this.dispatchBatch();
    } catch (error: unknown) {
      this.logger.error(`Email outbox batch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.running = false;
    }
  }

  async dispatchBatch(): Promise<number> {
    const now = new Date();
    // A worker may crash after claiming the eighth attempt. Once that lease expires,
    // dead-letter the row without making a ninth provider request.
    await db.update(emailOutbox).set({
      status: 'dead',
      lastError: 'maximum_attempts_reached_after_worker_crash',
      processingAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(or(
      and(eq(emailOutbox.status, 'pending'), gte(emailOutbox.attemptCount, MAX_ATTEMPTS)),
      and(eq(emailOutbox.status, 'processing'), lte(emailOutbox.leaseExpiresAt, now), gte(emailOutbox.attemptCount, MAX_ATTEMPTS)),
    ));

    const claimed = await db.transaction(async (tx) => {
      const rows = await tx.select().from(emailOutbox).where(or(
        and(eq(emailOutbox.status, 'pending'), lte(emailOutbox.nextAttemptAt, now), lt(emailOutbox.attemptCount, MAX_ATTEMPTS)),
        and(eq(emailOutbox.status, 'processing'), lte(emailOutbox.leaseExpiresAt, now), lt(emailOutbox.attemptCount, MAX_ATTEMPTS)),
      )).orderBy(asc(emailOutbox.createdAt)).limit(BATCH_SIZE).for('update', { skipLocked: true });

      const result = [];
      for (const row of rows) {
        const [updated] = await tx.update(emailOutbox).set({
          status: 'processing',
          attemptCount: row.attemptCount + 1,
          firstAttemptAt: row.firstAttemptAt ?? now,
          processingAt: now,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          updatedAt: now,
        }).where(eq(emailOutbox.id, row.id)).returning();
        if (updated) result.push({ ...updated, attemptCount: row.attemptCount + 1 });
      }
      return result;
    });

    for (const row of claimed) await this.deliver(row);
    return claimed.length;
  }

  private async deliver(row: typeof emailOutbox.$inferSelect & { attemptCount: number }): Promise<void> {
    const nowBeforeSend = new Date();
    if (row.firstAttemptAt && nowBeforeSend.getTime() - row.firstAttemptAt.getTime() >= MAX_AUTOMATIC_RETRY_AGE_MS) {
      await this.markDead(row.id, 'automatic_retry_window_expired; provider outcome may require manual review', nowBeforeSend);
      return;
    }
    const eventType = row.eventType as EmailEventType;
    const payload = row.payload as unknown as EmailEventPayload;
    const result = await this.emailService.sendEvent(eventType, row.recipient, payload, row.eventKey);
    const now = new Date();

    if (result.status === 'sent') {
      await db.update(emailOutbox).set({
        status: 'sent', sentAt: now, lastError: null, processingAt: null, leaseExpiresAt: null, updatedAt: now,
      }).where(eq(emailOutbox.id, row.id));
      return;
    }

    if (result.status === 'disabled') {
      await db.update(emailOutbox).set({
        status: 'pending',
        attemptCount: Math.max(0, row.attemptCount - 1),
        nextAttemptAt: new Date(now.getTime() + 60 * 60 * 1000),
        lastError: 'delivery_disabled_missing_configuration',
        processingAt: null,
        leaseExpiresAt: null,
        updatedAt: now,
      }).where(eq(emailOutbox.id, row.id));
      return;
    }

    if (result.status === 'permanent_failure') {
      await this.markDead(row.id, result.reason, now);
      return;
    }

    const firstAttemptAt = row.firstAttemptAt ?? now;
    const retryWindowExpired = now.getTime() - firstAttemptAt.getTime() >= MAX_AUTOMATIC_RETRY_AGE_MS;
    if (row.attemptCount >= MAX_ATTEMPTS || retryWindowExpired) {
      await this.markDead(row.id, `${result.reason}; automatic_retry_limit_reached`, now);
      return;
    }

    const delay = Math.min(30_000 * (2 ** (row.attemptCount - 1)), MAX_BACKOFF_MS);
    await db.update(emailOutbox).set({
      status: 'pending',
      nextAttemptAt: new Date(now.getTime() + delay),
      lastError: result.ambiguous ? `${result.reason}; provider_acceptance_unknown` : result.reason,
      processingAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(eq(emailOutbox.id, row.id));
  }

  private async markDead(id: string, reason: string, now: Date): Promise<void> {
    await db.update(emailOutbox).set({
      status: 'dead',
      lastError: reason.slice(0, 300),
      processingAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(eq(emailOutbox.id, id));
    this.logger.error(`Email outbox event ${id} moved to dead letter state: ${reason}`);
  }

  @Interval(24 * 60 * 60 * 1000)
  async purgeExpiredRecords(): Promise<void> {
    const now = Date.now();
    const sentCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const deadCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000);
    try {
      await db.delete(emailOutbox).where(or(
        and(eq(emailOutbox.status, 'sent'), isNotNull(emailOutbox.sentAt), lt(emailOutbox.sentAt, sentCutoff)),
        and(eq(emailOutbox.status, 'dead'), lt(emailOutbox.updatedAt, deadCutoff)),
      ));
    } catch (error: unknown) {
      this.logger.error(`Email outbox retention cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
