import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, lte } from 'drizzle-orm';
import { db } from '../db/database.js';
import { appointment, payment } from '../db/schema.js';
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
    await this.cleanupExpiredHolds();
  }

  /**
   * Periodic background task that releases expired appointment holds.
   * Runs every 30 seconds.
   */
  @Interval(30_000)
  async handleCron() {
    try {
      const cleaned = await this.cleanupExpiredHolds();
      if (cleaned > 0) {
        this.logger.log(`Released ${cleaned} expired appointment hold(s).`);
      }
    } catch (err) {
      this.logger.error('Error during scheduled hold cleanup:', err);
    }
  }

  /**
   * Safely and idempotently cancels expired `pending_payment` appointment holds.
   * Protects against race conditions with concurrent payment verification.
   */
  async cleanupExpiredHolds(now = new Date()): Promise<number> {
    return db.transaction(async (tx) => {
      // Select candidates without locks. Each candidate is then locked in the global
      // payment -> appointment order used by verification, webhooks, and cancellation.
      const expiredAppts = await tx
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

      if (expiredAppts.length === 0) {
        return 0;
      }

      let cancelledCount = 0;

      for (const candidate of expiredAppts) {
        // Lock payment first so expiry cannot deadlock against a payment confirmation.
        const [payRecord] = await tx
          .select({
            id: payment.id,
            status: payment.status,
          })
          .from(payment)
          .where(eq(payment.appointmentId, candidate.id))
          .for('update')
          .limit(1);

        // Re-read and lock the appointment after the payment lock; the initial candidate
        // list may have become stale while waiting for another transaction.
        const [appt] = await tx.select({
          id: appointment.id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          startsAt: appointment.startsAt,
          reminderGeneration: appointment.reminderGeneration,
        }).from(appointment).where(and(
          eq(appointment.id, candidate.id),
          eq(appointment.status, 'pending_payment'),
          lte(appointment.holdExpiresAt, now),
        )).for('update').limit(1);
        if (!appt) continue;

        if (payRecord && payRecord.status === 'captured') {
          // Payment succeeded in a concurrent transaction: ensure appointment is scheduled
          const scheduledAt = new Date();
          await tx.update(appointment)
            .set({
              status: 'scheduled',
              holdExpiresAt: null,
              updatedAt: scheduledAt,
            })
            .where(eq(appointment.id, appt.id));
          const timezone = await this.scheduleService?.getTimezoneForDoctor(appt.doctorId) ?? 'Asia/Kolkata';
          await this.appointmentReminders?.scheduleForAppointment(tx, {
            id: appt.id,
            patientId: appt.patientId,
            doctorId: appt.doctorId,
            startsAt: appt.startsAt,
            updatedAt: scheduledAt,
            reminderGeneration: appt.reminderGeneration,
          }, timezone, now);
          continue;
        }

        // 3. Mark payment as failed if it was left in created state
        if (payRecord && payRecord.status === 'created') {
          await tx
            .update(payment)
            .set({
              status: 'failed',
              failureReason: 'Hold expired before payment completion',
              updatedAt: new Date(),
            })
            .where(eq(payment.id, payRecord.id));
        }

        // 4. Cancel the appointment to release the doctor's slot in the exclusion constraint
        await tx
          .update(appointment)
          .set({
            status: 'cancelled',
            updatedAt: new Date(),
          })
          .where(and(eq(appointment.id, appt.id), eq(appointment.status, 'pending_payment')));

        cancelledCount++;
      }

      return cancelledCount;
    });
  }
}
