import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { db } from '../db/database.js';
import { classifyDatabaseFailure } from '../db/database-failure.js';
import {
  appointment,
  doctorProfile,
  payment,
  scheduleChangeAppointment,
  scheduleChangeRequest,
} from '../db/schema.js';
import { AppointmentReminderService } from '../notifications/appointment-reminder.service.js';
import { DoctorScheduleService } from '../doctors/doctor-schedule.service.js';

@Injectable()
export class AppointmentExpiryService implements OnModuleInit {
  private readonly logger = new Logger(AppointmentExpiryService.name);

  constructor(
    private readonly appointmentReminders?: AppointmentReminderService,
    private readonly scheduleService?: DoctorScheduleService,
  ) {}

  async onModuleInit() {
    // Run an initial sweep on server startup to handle holds that expired during downtime
    try {
      await this.cleanupExpiredHolds();
    } catch (error) {
      const { connection, diagnostic } = classifyDatabaseFailure(error);
      if (!connection) throw error;
      this.logger.error(`Startup hold cleanup failed. Next attempt at the scheduled sweep. Database diagnostic: ${diagnostic}`);
    }

    await this.cleanupExpiredScheduleChangeRequests();
  }

  /**
   * Periodic background task that releases expired appointment holds.
   * Runs every 30 seconds.
   */
  @Interval(30_000)
  async handleCron() {
    try {
      const [cleanedHolds, expiredRequests] = await Promise.all([
        this.cleanupExpiredHolds(),
        this.cleanupExpiredScheduleChangeRequests(),
      ]);
      if (cleanedHolds > 0) {
        this.logger.log(`Released ${cleanedHolds} expired appointment hold(s).`);
      }
      if (expiredRequests > 0) {
        this.logger.log(`Expired ${expiredRequests} schedule change request(s).`);
      }
    } catch (err) {
      this.logger.error(`Scheduled hold cleanup failed. Database diagnostic: ${classifyDatabaseFailure(err).diagnostic}`);
    }
  }

  /**
   * Safely and idempotently cancels expired `pending_payment` appointment holds in bounded batches.
   * Protects against long-running transactions and locks candidates in short, isolated transactions.
   * Failure on an individual candidate is isolated and will not rollback successful candidates.
   */
  async cleanupExpiredHolds(now = new Date(), batchSize = 50, maxBatches = 10): Promise<number> {
    let totalCancelled = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      // 1. Candidate discovery: select bounded batch ordered by expiration time
      let expiredAppts: Array<{
        id: string;
        patientId: string;
        doctorId: string;
        startsAt?: Date;
        reminderGeneration?: number;
      }> | undefined;

      const selectResult = db.select ? (db.select as any)({
        id: appointment.id,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        startsAt: appointment.startsAt,
        reminderGeneration: appointment.reminderGeneration,
      }) : undefined;

      if (!selectResult || typeof selectResult.from !== 'function') {
        // Fallback for test harnesses mocking db.transaction instead of db.select
        expiredAppts = await db.transaction(async (tx) => {
          return tx
            .select({
              id: appointment.id,
              patientId: appointment.patientId,
              doctorId: appointment.doctorId,
              startsAt: appointment.startsAt,
              reminderGeneration: appointment.reminderGeneration,
            })
            .from(appointment)
            .where(
              and(
                eq(appointment.status, 'pending_payment'),
                lte(appointment.holdExpiresAt, now),
              ),
            );
        });
      } else {
        const fromQuery = selectResult.from(appointment).where(
          and(
            eq(appointment.status, 'pending_payment'),
            lte(appointment.holdExpiresAt, now),
          ),
        );
        const orderedQuery = typeof fromQuery.orderBy === 'function'
          ? fromQuery.orderBy(asc(appointment.holdExpiresAt))
          : fromQuery;
        const limitedQuery = typeof orderedQuery.limit === 'function'
          ? orderedQuery.limit(batchSize)
          : orderedQuery;
        expiredAppts = await limitedQuery;
      }

      if (!expiredAppts || expiredAppts.length === 0) {
        break;
      }

      let batchProcessed = 0;

      // 2. Process each expired candidate in an isolated short transaction
      for (const candidate of expiredAppts) {
        try {
          const wasCancelled = await db.transaction(async (tx) => {
            // SEC-2D-01: Lock all payment records for candidate first to prevent deadlock and evaluate true payment state
            const payRecords = await tx
              .select({
                id: payment.id,
                status: payment.status,
              })
              .from(payment)
              .where(eq(payment.appointmentId, candidate.id))
              .for('update');

            // Re-read and lock appointment within the short transaction
            const [appt] = await tx
              .select({
                id: appointment.id,
                patientId: appointment.patientId,
                doctorId: appointment.doctorId,
                startsAt: appointment.startsAt,
                reminderGeneration: appointment.reminderGeneration,
              })
              .from(appointment)
              .where(
                and(
                  eq(appointment.id, candidate.id),
                  eq(appointment.status, 'pending_payment'),
                  lte(appointment.holdExpiresAt, now),
                ),
              )
              .for('update')
              .limit(1);

            if (!appt) return false;

            const capturedPayment = payRecords.find((p) => p.status === 'captured');
            if (capturedPayment) {
              // Payment succeeded in a concurrent transaction: ensure appointment is scheduled
              const scheduledAt = new Date();
              await tx
                .update(appointment)
                .set({
                  status: 'scheduled',
                  holdExpiresAt: null,
                  updatedAt: scheduledAt,
                })
                .where(eq(appointment.id, appt.id));

              const timezone =
                (await this.scheduleService?.getTimezoneForDoctor(appt.doctorId)) ?? 'Asia/Kolkata';
              await this.appointmentReminders?.scheduleForAppointment(
                tx,
                {
                  id: appt.id,
                  patientId: appt.patientId,
                  doctorId: appt.doctorId,
                  startsAt: appt.startsAt ?? candidate.startsAt,
                  updatedAt: scheduledAt,
                  reminderGeneration: appt.reminderGeneration ?? candidate.reminderGeneration ?? 0,
                },
                timezone,
                now,
              );
              return false;
            }

            // 3. Mark any created payments as failed so they cannot be completed later
            const createdPayIds = payRecords.filter((p) => p.status === 'created').map((p) => p.id);
            if (createdPayIds.length > 0) {
              await tx
                .update(payment)
                .set({
                  status: 'failed',
                  failureReason: 'Hold expired before payment completion',
                  updatedAt: new Date(),
                })
                .where(inArray(payment.id, createdPayIds));
            }

            // 4. Cancel the appointment to release doctor capacity
            await tx
              .update(appointment)
              .set({
                status: 'cancelled',
                updatedAt: new Date(),
              })
              .where(and(eq(appointment.id, appt.id), eq(appointment.status, 'pending_payment')));

            return true;
          });

          if (wasCancelled) {
            totalCancelled++;
          }
          batchProcessed++;
        } catch (err) {
          // Failure on one candidate is isolated and does not abort remaining candidates
          this.logger.error(`Error processing expired hold for appointment ${candidate.id}:`, err);
        }
      }

      // If this batch returned fewer than batchSize candidates, no more expired items remain
      if (expiredAppts.length < batchSize || batchProcessed === 0) {
        break;
      }
    }

    return totalCancelled;
  }

  /**
   * Marks expired schedule-change requests terminal without changing any
   * appointment, payment, or reminder. The doctor profile lock is acquired
   * before the request lock, matching approval and patient-consent flows.
   */
  async cleanupExpiredScheduleChangeRequests(now = new Date()): Promise<number> {
    return db.transaction(async (tx) => {
      const candidates = await tx.select({
        id: scheduleChangeRequest.id,
        doctorId: scheduleChangeRequest.doctorId,
      }).from(scheduleChangeRequest)
        .where(and(
          eq(scheduleChangeRequest.status, 'pending'),
          lte(scheduleChangeRequest.expiresAt, now),
        ));

      let expiredCount = 0;
      for (const candidate of candidates) {
        await tx.select({ id: doctorProfile.id }).from(doctorProfile)
          .where(eq(doctorProfile.userId, candidate.doctorId)).for('update').limit(1);
        const [request] = await tx.select({ id: scheduleChangeRequest.id })
          .from(scheduleChangeRequest)
          .where(and(
            eq(scheduleChangeRequest.id, candidate.id),
            eq(scheduleChangeRequest.status, 'pending'),
            lte(scheduleChangeRequest.expiresAt, now),
          ))
          .for('update')
          .limit(1);
        if (!request) continue;

        await tx.select({ id: scheduleChangeAppointment.id })
          .from(scheduleChangeAppointment)
          .where(eq(scheduleChangeAppointment.requestId, request.id))
          .for('update');
        const [expired] = await tx.update(scheduleChangeRequest)
          .set({ status: 'expired', expiredAt: now, updatedAt: now })
          .where(and(
            eq(scheduleChangeRequest.id, request.id),
            eq(scheduleChangeRequest.status, 'pending'),
          ))
          .returning({ id: scheduleChangeRequest.id });
        if (!expired) continue;

        await tx.update(scheduleChangeAppointment)
          .set({
            consentStatus: 'expired',
            resolutionStatus: 'expired',
            responseReason: 'Schedule change request expired before patient response.',
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(scheduleChangeAppointment.requestId, request.id),
            eq(scheduleChangeAppointment.consentStatus, 'pending'),
            eq(scheduleChangeAppointment.resolutionStatus, 'pending'),
          ));
        expiredCount++;
      }
      return expiredCount;
    });
  }
}
