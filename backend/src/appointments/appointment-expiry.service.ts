import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, lte } from 'drizzle-orm';
import { db } from '../db/database.js';
import { appointment, payment } from '../db/schema.js';

@Injectable()
export class AppointmentExpiryService implements OnModuleInit {
  private readonly logger = new Logger(AppointmentExpiryService.name);

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
      // 1. Select expired pending_payment appointments using row-level locking
      // SKIP LOCKED ensures we do not block or deadlock with active verification transactions
      const expiredAppts = await tx
        .select({
          id: appointment.id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
        })
        .from(appointment)
        .where(
          and(
            eq(appointment.status, 'pending_payment'),
            lte(appointment.holdExpiresAt, now),
          ),
        )
        .for('update', { skipLocked: true });

      if (expiredAppts.length === 0) {
        return 0;
      }

      let cancelledCount = 0;

      for (const appt of expiredAppts) {
        // 2. Race condition check: Verify if payment was captured right as hold expired
        const [payRecord] = await tx
          .select({
            id: payment.id,
            status: payment.status,
          })
          .from(payment)
          .where(eq(payment.appointmentId, appt.id))
          .for('update', { skipLocked: true })
          .limit(1);

        if (payRecord && payRecord.status === 'captured') {
          // Payment succeeded in a concurrent transaction: ensure appointment is scheduled
          await tx
            .update(appointment)
            .set({
              status: 'scheduled',
              holdExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(eq(appointment.id, appt.id));
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
