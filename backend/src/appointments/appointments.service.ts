import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { AuthenticatedUser, UserRole } from '../auth/authenticated-user.js';
import { db } from '../db/database.js';
import { appointment, appointmentHistory, doctorAvailability, doctorProfile, doctorScheduleOverride, payment, refund, scheduleChangeAlternative, scheduleChangeAppointment, scheduleChangeRequest, user } from '../db/schema.js';
import { DoctorProfilesService } from '../doctors/doctor-profiles.service.js';
import { DoctorScheduleService } from '../doctors/doctor-schedule.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PaymentReconciliationService } from '../payments/payment-reconciliation.service.js';
import { EmailOutboxService, emailEventKey } from '../notifications/email-outbox.service.js';
import { AppointmentReminderService } from '../notifications/appointment-reminder.service.js';
import type { EmailEventType } from '../notifications/email-templates.js';
import { canAccessAppointment } from './appointment-access.js';
import { createWithConflictHandling, reserveWithinCapacity } from './appointment-conflict.js';
import { createZonedDate, getAvailableSlotsWithCapacity, getBookableRescheduleWindow, getDurationForDate, isBookableSlot } from './appointment-availability.js';
import type { AppointmentAvailabilityQuery } from './appointment-availability.schema.js';
import type { z } from 'zod';
import type { appointmentBookingSchema } from './appointment-booking.schema.js';
import type { AppointmentRescheduleInput } from './appointment-reschedule.schema.js';
import { doctorScheduleUpdateSchema } from '../doctors/doctor-schedule.schema.js';
import { randomUUID } from 'node:crypto';

type AppointmentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface PatientAppointmentRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: 'pending_payment' | 'scheduled' | 'cancelled' | 'completed';
  holdExpiresAt: Date | null;
  doctor: {
    id: string;
    name: string;
    specialty: string;
    bio: string | null;
  };
  payment?: {
    id: string;
    status: 'created' | 'captured' | 'failed' | 'refunded';
    amountPaise: number;
    currency: string;
    razorpayPaymentId: string | null;
    refundedAmountPaise: number | null;
  } | null;
}

interface DoctorAppointmentRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: 'pending_payment' | 'scheduled' | 'cancelled' | 'completed';
  holdExpiresAt: Date | null;
  patient: {
    id: string;
    name: string;
  };
  payment?: {
    id: string;
    status: 'created' | 'captured' | 'failed' | 'refunded';
    amountPaise: number;
    currency: string;
    refundedAmountPaise: number | null;
  } | null;
}

export function resolvePaymentStatusDisplay(
  paymentRecord: {
    status: 'created' | 'captured' | 'failed' | 'refunded';
    amountPaise: number;
    refundedAmountPaise: number | null;
  } | null | undefined,
  latestRefund?: {
    status: 'pending' | 'processed' | 'failed';
  } | null,
): {
  statusDisplay:
    | 'Paid'
    | 'Payment Pending'
    | 'Payment Failed'
    | 'Refund Pending'
    | 'Refund Failed'
    | 'Partially Refunded'
    | 'Refunded'
    | 'Unpaid';
} {
  if (!paymentRecord) {
    return { statusDisplay: 'Unpaid' };
  }

  if (paymentRecord.status === 'created') {
    return { statusDisplay: 'Payment Pending' };
  }

  if (paymentRecord.status === 'failed') {
    return { statusDisplay: 'Payment Failed' };
  }

  if (paymentRecord.status === 'refunded') {
    return { statusDisplay: 'Refunded' };
  }

  if (paymentRecord.status === 'captured') {
    const refundedPaise = paymentRecord.refundedAmountPaise ?? 0;
    if (refundedPaise >= paymentRecord.amountPaise) {
      return { statusDisplay: 'Refunded' };
    }
    if (refundedPaise > 0) {
      return { statusDisplay: 'Partially Refunded' };
    }
    if (latestRefund?.status === 'pending') {
      return { statusDisplay: 'Refund Pending' };
    }
    if (latestRefund?.status === 'processed') {
      return { statusDisplay: 'Refunded' };
    }
    if (latestRefund?.status === 'failed') {
      return { statusDisplay: 'Refund Failed' };
    }
    return { statusDisplay: 'Paid' };
  }

  return { statusDisplay: 'Payment Pending' };
}

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly doctors: DoctorProfilesService,
    @Optional() private readonly scheduleService?: DoctorScheduleService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly payments?: PaymentsService,
    @Optional() private readonly reconciliation?: PaymentReconciliationService,
    @Optional() private readonly emailOutbox?: EmailOutboxService,
    @Optional() private readonly appointmentReminders?: AppointmentReminderService,
  ) {}

  private async enqueueAppointmentEmails(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    type: 'appointment_cancelled' | 'appointment_rescheduled',
    record: { id: string; patientId: string; doctorId: string },
    startsAt: Date,
    eventSuffix: string,
  ): Promise<void> {
    if (!this.emailOutbox) return;
    const participants = await tx.select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, [record.patientId, record.doctorId]));
    const patient = participants.find((participant) => participant.id === record.patientId);
    const doctor = participants.find((participant) => participant.id === record.doctorId);
    if (!patient || !doctor) return;
    const timezone = await this.scheduleService?.getTimezoneForDoctor(record.doctorId);

    const recipients = [
      { user: patient, otherPartyName: `Dr. ${doctor.name}` },
      { user: doctor, otherPartyName: patient.name },
    ];
    for (const recipient of recipients) {
      const eventType: EmailEventType = type;
      await this.emailOutbox.enqueue(tx, {
          eventKey: emailEventKey.appointment(type, record.id, eventSuffix, recipient.user.id),
        eventType,
        recipient: recipient.user.email,
        appointmentId: record.id,
        payload: {
          recipientName: recipient.user.name,
          otherPartyName: recipient.otherPartyName,
          ...(timezone ? { startsAt: startsAt.toISOString(), timezone } : {}),
        },
      });
    }
  }

  private async lockDoctorCapacity(tx: AppointmentTransaction, doctorId: string): Promise<void> {
    // A database row lock serializes capacity checks and inserts for this doctor
    // across all application instances.
    await tx.select({ id: doctorProfile.id }).from(doctorProfile)
      .where(eq(doctorProfile.userId, doctorId)).for('update').limit(1);
  }

  private async getCapacityForDate(tx: AppointmentTransaction, doctorId: string, date: string): Promise<number> {
    const [weekly] = await tx.select({ capacity: doctorAvailability.capacity }).from(doctorAvailability)
      .where(eq(doctorAvailability.doctorId, doctorId)).limit(1);
    const [override] = await tx.select({ capacity: doctorScheduleOverride.capacity }).from(doctorScheduleOverride)
      .where(and(
        eq(doctorScheduleOverride.doctorId, doctorId),
        eq(doctorScheduleOverride.date, date),
      )).limit(1);
    return override?.capacity ?? weekly?.capacity ?? 1;
  }

  async getAvailableSlots(patientId: string, input: AppointmentAvailabilityQuery) {
    const doctor = await this.findApprovedDoctor(input.doctorProfileId);
    if (!doctor) throw new NotFoundException('Approved doctor not found.');
    if (doctor.userId === patientId) throw new ForbiddenException();

    const scheduleConfig = this.scheduleService
      ? await this.scheduleService.getScheduleConfigForProfile(input.doctorProfileId)
      : { timezone: 'Asia/Kolkata', slotDurationMinutes: 30 };

    const tz = scheduleConfig.timezone ?? 'Asia/Kolkata';
    const dayStart = createZonedDate(input.date, 0, 0, tz);
    const nextDate = new Date(`${input.date}T12:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const nextDateString = nextDate.toISOString().slice(0, 10);
    const dayEnd = createZonedDate(nextDateString, 0, 0, tz);
    const now = new Date();

    const busy = await db.select({
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      holdExpiresAt: appointment.holdExpiresAt,
    })
      .from(appointment)
      .where(and(
        eq(appointment.doctorId, doctor.userId),
        lt(appointment.startsAt, dayEnd),
        gt(appointment.endsAt, dayStart),
        or(
          eq(appointment.status, 'scheduled'),
          and(
            eq(appointment.status, 'pending_payment'),
            gt(appointment.holdExpiresAt, now),
          ),
        ),
      ));

    const slots = getAvailableSlotsWithCapacity(input.date, busy, now, {
      ...scheduleConfig,
      timezone: tz,
    });

    const override = scheduleConfig.dateOverrides?.find((entry) => entry.date === input.date);
    const mode = override?.schedulingMode ?? scheduleConfig.schedulingMode ?? 'stream';
    const capacity = override?.capacity ?? scheduleConfig.capacity ?? 1;
    const durationMinutes = getDurationForDate(input.date, scheduleConfig);

    return {
      doctorProfileId: input.doctorProfileId,
      date: input.date,
      timezone: tz,
      durationMinutes,
      mode,
      capacity,
      slots: slots.map(({ startsAt, endsAt, mode: slotMode, slotId, sessionId, capacity: slotCapacity, remainingCapacity }) => ({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        mode: slotMode,
        slotId: `${doctor.userId}:${slotId}`,
        sessionId: sessionId ? `${doctor.userId}:${sessionId}` : null,
        capacity: slotCapacity,
        remainingCapacity,
      })),
    };
  }

  async createForPatient(patientId: string, input: z.infer<typeof appointmentBookingSchema>) {
    const doctor = await this.findApprovedDoctor(input.doctorProfileId);
    if (!doctor) throw new NotFoundException('Approved doctor not found.');
    if (doctor.userId === patientId) throw new ForbiddenException();

    const scheduleConfig = this.scheduleService
      ? await this.scheduleService.getScheduleConfigForProfile(input.doctorProfileId)
      : { timezone: 'Asia/Kolkata', slotDurationMinutes: 30 };
    const tz = scheduleConfig.timezone ?? 'Asia/Kolkata';

    if (!isBookableSlot(input.startsAt, input.endsAt, new Date(), { ...scheduleConfig, timezone: tz })) {
      throw new BadRequestException('The selected slot is not within the doctor’s available schedule.');
    }

    return createWithConflictHandling(() => db.transaction(async (tx) => {
      return reserveWithinCapacity(
        () => this.lockDoctorCapacity(tx, doctor.userId),
        async () => {
          const currentConfig = this.scheduleService
            ? await this.scheduleService.getScheduleConfigForProfile(input.doctorProfileId)
            : scheduleConfig;
          const currentTimezone = currentConfig.timezone ?? 'Asia/Kolkata';
          if (!isBookableSlot(input.startsAt, input.endsAt, new Date(), {
            ...currentConfig,
            timezone: currentTimezone,
          })) {
            throw new BadRequestException('The selected slot is not within the doctor’s available schedule.');
          }
          const date = new Intl.DateTimeFormat('en-CA', { timeZone: currentTimezone }).format(input.startsAt);
          return this.getCapacityForDate(tx, doctor.userId, date);
        },
        async () => {
          const now = new Date();
          await tx.update(appointment)
            .set({ status: 'cancelled', updatedAt: now })
            .where(and(
              eq(appointment.doctorId, doctor.userId),
              eq(appointment.status, 'pending_payment'),
              lte(appointment.holdExpiresAt, now),
              lt(appointment.startsAt, input.endsAt),
              gt(appointment.endsAt, input.startsAt),
            ));
          const occupied = await tx.select({ id: appointment.id }).from(appointment).where(and(
            eq(appointment.doctorId, doctor.userId),
            or(
              eq(appointment.status, 'scheduled'),
              and(eq(appointment.status, 'pending_payment'), gt(appointment.holdExpiresAt, now)),
            ),
            lt(appointment.startsAt, input.endsAt),
            gt(appointment.endsAt, input.startsAt),
          ));
          return occupied.length;
        },
        async () => {
          const now = new Date();
          const [created] = await tx.insert(appointment).values({
            id: randomUUID(), patientId, doctorId: doctor.userId,
            startsAt: input.startsAt, endsAt: input.endsAt,
            status: 'pending_payment', holdExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
          }).returning({
            id: appointment.id,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            status: appointment.status,
            holdExpiresAt: appointment.holdExpiresAt,
          });
          return created;
        },
      );
    }));
  }

  async listMine(actor: AuthenticatedUser) {
    await this.assertDoctorApproved(actor.role, actor.id);
    if (actor.role === 'patient') {
      const baseQuery = db
        .select({
          id: appointment.id,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
          holdExpiresAt: appointment.holdExpiresAt,
          doctor: {
            id: doctorProfile.id,
            name: user.name,
            specialty: doctorProfile.specialty,
            bio: doctorProfile.bio,
          },
          payment: {
            id: payment.id,
            status: payment.status,
            amountPaise: payment.amountPaise,
            currency: payment.currency,
            razorpayPaymentId: payment.razorpayPaymentId,
            refundedAmountPaise: payment.refundedAmountPaise,
          },
        })
        .from(appointment)
        .innerJoin(user, eq(user.id, appointment.doctorId))
        .innerJoin(doctorProfile, eq(doctorProfile.userId, user.id));

      const records: PatientAppointmentRow[] = typeof (baseQuery as any).leftJoin === 'function'
        ? await (baseQuery as any)
            .leftJoin(payment, eq(payment.appointmentId, appointment.id))
            .where(eq(appointment.patientId, actor.id))
        : await (baseQuery as any).where(eq(appointment.patientId, actor.id));

      const paymentIds = records
        .map((r) => r.payment?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      const refundMap = new Map<string, typeof refund.$inferSelect>();
      if (paymentIds.length > 0) {
        const initialRefQuery = db
          .select()
          .from(refund)
          .where(inArray(refund.paymentId, paymentIds));
        let refunds =
          typeof (initialRefQuery as any).orderBy === 'function'
            ? await (initialRefQuery as any).orderBy(desc(refund.createdAt))
            : await initialRefQuery;

        if (this.reconciliation) {
          const pending = refunds.filter((r: any) => r.status === 'pending');
          if (pending.length > 0) {
            let anyReconciled = false;
            for (const pRef of pending) {
              const res = await this.reconciliation.reconcilePendingRefund(pRef);
              if (res) anyReconciled = true;
            }
            if (anyReconciled) {
              const refreshRefQuery = db
                .select()
                .from(refund)
                .where(inArray(refund.paymentId, paymentIds));
              refunds =
                typeof (refreshRefQuery as any).orderBy === 'function'
                  ? await (refreshRefQuery as any).orderBy(desc(refund.createdAt))
                  : await refreshRefQuery;

              const freshPayments = await db
                .select({
                  id: payment.id,
                  status: payment.status,
                  amountPaise: payment.amountPaise,
                  currency: payment.currency,
                  razorpayPaymentId: payment.razorpayPaymentId,
                  refundedAmountPaise: payment.refundedAmountPaise,
                })
                .from(payment)
                .where(inArray(payment.id, paymentIds));

              const freshPayMap = new Map(freshPayments.map((p) => [p.id, p]));
              for (const rec of records) {
                if (rec.payment?.id && freshPayMap.has(rec.payment.id)) {
                  rec.payment = freshPayMap.get(rec.payment.id)!;
                }
              }
            }
          }
        }

        for (const ref of refunds) {
          if (!refundMap.has(ref.paymentId)) {
            refundMap.set(ref.paymentId, ref);
          }
        }
      }

      return records.map((r) => {
        const pay = r.payment?.id ? r.payment : null;
        const ref = pay ? refundMap.get(pay.id) : null;
        const paymentState = resolvePaymentStatusDisplay(pay, ref);

        return {
          id: r.id,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          status: r.status,
          holdExpiresAt: r.holdExpiresAt,
          doctor: r.doctor,
          payment: pay
            ? {
                id: pay.id,
                status: pay.status,
                statusDisplay: paymentState.statusDisplay,
                amountPaise: pay.amountPaise,
                currency: pay.currency,
                method: 'Razorpay',
                razorpayPaymentId: pay.razorpayPaymentId,
                refundedAmountPaise: pay.refundedAmountPaise ?? 0,
                refund: ref
                  ? {
                      id: ref.id,
                      status: ref.status,
                      amountPaise: ref.amountPaise,
                      currency: ref.currency,
                      arn: ref.arn,
                      createdAt: ref.createdAt,
                    }
                  : null,
              }
            : null,
        };
      });
    }

    if (actor.role === 'doctor') {
      const baseQuery = db
        .select({
          id: appointment.id,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
          holdExpiresAt: appointment.holdExpiresAt,
          patient: { id: user.id, name: user.name },
          payment: {
            id: payment.id,
            status: payment.status,
            amountPaise: payment.amountPaise,
            currency: payment.currency,
            refundedAmountPaise: payment.refundedAmountPaise,
          },
        })
        .from(appointment)
        .innerJoin(user, and(eq(user.id, appointment.patientId), eq(user.role, 'patient')));

      const records: DoctorAppointmentRow[] = typeof (baseQuery as any).leftJoin === 'function'
        ? await (baseQuery as any)
            .leftJoin(payment, eq(payment.appointmentId, appointment.id))
            .where(eq(appointment.doctorId, actor.id))
        : await (baseQuery as any).where(eq(appointment.doctorId, actor.id));

      const paymentIds = records
        .map((r) => r.payment?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      const refundMap = new Map<string, typeof refund.$inferSelect>();
      if (paymentIds.length > 0) {
        const initialRefQuery = db
          .select()
          .from(refund)
          .where(inArray(refund.paymentId, paymentIds));
        let refunds =
          typeof (initialRefQuery as any).orderBy === 'function'
            ? await (initialRefQuery as any).orderBy(desc(refund.createdAt))
            : await initialRefQuery;

        if (this.reconciliation) {
          const pending = refunds.filter((r: any) => r.status === 'pending');
          if (pending.length > 0) {
            let anyReconciled = false;
            for (const pRef of pending) {
              const res = await this.reconciliation.reconcilePendingRefund(pRef);
              if (res) anyReconciled = true;
            }
            if (anyReconciled) {
              const refreshRefQuery = db
                .select()
                .from(refund)
                .where(inArray(refund.paymentId, paymentIds));
              refunds =
                typeof (refreshRefQuery as any).orderBy === 'function'
                  ? await (refreshRefQuery as any).orderBy(desc(refund.createdAt))
                  : await refreshRefQuery;

              const freshPayments = await db
                .select({
                  id: payment.id,
                  status: payment.status,
                  amountPaise: payment.amountPaise,
                  currency: payment.currency,
                  razorpayPaymentId: payment.razorpayPaymentId,
                  refundedAmountPaise: payment.refundedAmountPaise,
                })
                .from(payment)
                .where(inArray(payment.id, paymentIds));

              const freshPayMap = new Map(freshPayments.map((p) => [p.id, p]));
              for (const rec of records) {
                if (rec.payment?.id && freshPayMap.has(rec.payment.id)) {
                  rec.payment = freshPayMap.get(rec.payment.id)!;
                }
              }
            }
          }
        }

        for (const ref of refunds) {
          if (!refundMap.has(ref.paymentId)) {
            refundMap.set(ref.paymentId, ref);
          }
        }
      }

      return records.map((r) => {
        const pay = r.payment?.id ? r.payment : null;
        const ref = pay ? refundMap.get(pay.id) : null;
        const paymentState = resolvePaymentStatusDisplay(pay, ref);

        return {
          id: r.id,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          status: r.status,
          holdExpiresAt: r.holdExpiresAt,
          patient: r.patient,
          payment: pay
            ? {
                status: pay.status,
                statusDisplay: paymentState.statusDisplay,
                amountPaise: pay.amountPaise,
                currency: pay.currency,
              }
            : null,
        };
      });
    }
    throw new ForbiddenException();
  }

  async getMine(id: string, actor: AuthenticatedUser) {
    await this.assertDoctorApproved(actor.role, actor.id);
    const [participants] = await db.select({ id: appointment.id, patientId: appointment.patientId, doctorId: appointment.doctorId })
      .from(appointment).where(eq(appointment.id, id)).limit(1);

    if (!participants || !canAccessAppointment(actor.role, actor.id, participants)) throw new NotFoundException('Appointment not found.');

    if (actor.role === 'patient') {
      const baseQuery = db
        .select({
          id: appointment.id,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
          holdExpiresAt: appointment.holdExpiresAt,
          doctor: {
            id: doctorProfile.id,
            name: user.name,
            specialty: doctorProfile.specialty,
            bio: doctorProfile.bio,
          },
          payment: {
            id: payment.id,
            status: payment.status,
            amountPaise: payment.amountPaise,
            currency: payment.currency,
            razorpayPaymentId: payment.razorpayPaymentId,
            refundedAmountPaise: payment.refundedAmountPaise,
          },
        })
        .from(appointment)
        .innerJoin(user, eq(user.id, appointment.doctorId))
        .innerJoin(doctorProfile, eq(doctorProfile.userId, user.id));

      const [record]: (PatientAppointmentRow | undefined)[] = typeof (baseQuery as any).leftJoin === 'function'
        ? await (baseQuery as any)
            .leftJoin(payment, eq(payment.appointmentId, appointment.id))
            .where(and(eq(appointment.id, id), eq(appointment.patientId, actor.id)))
            .limit(1)
        : await (baseQuery as any)
            .where(and(eq(appointment.id, id), eq(appointment.patientId, actor.id)))
            .limit(1);

      if (!record) throw new NotFoundException('Appointment not found.');

      const pay = record.payment?.id ? record.payment : null;
      let ref: typeof refund.$inferSelect | null = null;
      if (pay) {
        let [latestRefund] = await db
          .select()
          .from(refund)
          .where(eq(refund.paymentId, pay.id))
          .orderBy(desc(refund.createdAt))
          .limit(1);

        if (latestRefund?.status === 'pending' && this.reconciliation) {
          const rec = await this.reconciliation.reconcilePendingRefund(latestRefund);
          if (rec) {
            const [freshRef] = await db
              .select()
              .from(refund)
              .where(eq(refund.id, latestRefund.id))
              .limit(1);
            latestRefund = freshRef;

            const [freshPay] = await db
              .select({
                id: payment.id,
                status: payment.status,
                amountPaise: payment.amountPaise,
                currency: payment.currency,
                razorpayPaymentId: payment.razorpayPaymentId,
                refundedAmountPaise: payment.refundedAmountPaise,
              })
              .from(payment)
              .where(eq(payment.id, pay.id))
              .limit(1);
            if (freshPay) {
              record.payment = freshPay;
            }
          }
        }
        ref = latestRefund ?? null;
      }
      const paymentState = resolvePaymentStatusDisplay(pay, ref);

      return {
        id: record.id,
        startsAt: record.startsAt,
        endsAt: record.endsAt,
        status: record.status,
        holdExpiresAt: record.holdExpiresAt,
        doctor: record.doctor,
        payment: pay
          ? {
              id: pay.id,
              status: pay.status,
              statusDisplay: paymentState.statusDisplay,
              amountPaise: pay.amountPaise,
              currency: pay.currency,
              method: 'Razorpay',
              razorpayPaymentId: pay.razorpayPaymentId,
              refundedAmountPaise: pay.refundedAmountPaise ?? 0,
              refund: ref
                ? {
                    id: ref.id,
                    status: ref.status,
                    amountPaise: ref.amountPaise,
                    currency: ref.currency,
                    arn: ref.arn,
                    createdAt: ref.createdAt,
                  }
                : null,
            }
          : null,
      };
    }
    if (actor.role === 'doctor') {
      const baseQuery = db
        .select({
          id: appointment.id,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
          holdExpiresAt: appointment.holdExpiresAt,
          patient: { id: user.id, name: user.name },
          payment: {
            id: payment.id,
            status: payment.status,
            amountPaise: payment.amountPaise,
            currency: payment.currency,
            refundedAmountPaise: payment.refundedAmountPaise,
          },
        })
        .from(appointment)
        .innerJoin(user, and(eq(user.id, appointment.patientId), eq(user.role, 'patient')));

      const [record]: (DoctorAppointmentRow | undefined)[] = typeof (baseQuery as any).leftJoin === 'function'
        ? await (baseQuery as any)
            .leftJoin(payment, eq(payment.appointmentId, appointment.id))
            .where(and(eq(appointment.id, id), eq(appointment.doctorId, actor.id)))
            .limit(1)
        : await (baseQuery as any)
            .where(and(eq(appointment.id, id), eq(appointment.doctorId, actor.id)))
            .limit(1);

      if (!record) throw new NotFoundException('Appointment not found.');

      const pay = record.payment?.id ? record.payment : null;
      let ref: typeof refund.$inferSelect | null = null;
      if (pay) {
        let [latestRefund] = await db
          .select()
          .from(refund)
          .where(eq(refund.paymentId, pay.id))
          .orderBy(desc(refund.createdAt))
          .limit(1);

        if (latestRefund?.status === 'pending' && this.reconciliation) {
          const rec = await this.reconciliation.reconcilePendingRefund(latestRefund);
          if (rec) {
            const [freshRef] = await db
              .select()
              .from(refund)
              .where(eq(refund.id, latestRefund.id))
              .limit(1);
            latestRefund = freshRef;

            const [freshPay] = await db
              .select({
                id: payment.id,
                status: payment.status,
                amountPaise: payment.amountPaise,
                currency: payment.currency,
                razorpayPaymentId: payment.razorpayPaymentId,
                refundedAmountPaise: payment.refundedAmountPaise,
              })
              .from(payment)
              .where(eq(payment.id, pay.id))
              .limit(1);
            if (freshPay) {
              record.payment = freshPay;
            }
          }
        }
        ref = latestRefund ?? null;
      }
      const paymentState = resolvePaymentStatusDisplay(pay, ref);

      return {
        id: record.id,
        startsAt: record.startsAt,
        endsAt: record.endsAt,
        status: record.status,
        holdExpiresAt: record.holdExpiresAt,
        patient: record.patient,
        payment: pay
          ? {
              status: pay.status,
              statusDisplay: paymentState.statusDisplay,
              amountPaise: pay.amountPaise,
              currency: pay.currency,
            }
          : null,
      };
    }
    throw new NotFoundException('Appointment not found.');
  }

  async getPatientForDoctorAppointment(id: string, doctorId: string) {
    await this.assertDoctorApproved('doctor', doctorId);
    const [patient] = await db.select({ id: user.id, name: user.name }).from(appointment)
      .innerJoin(user, and(eq(user.id, appointment.patientId), eq(user.role, 'patient')))
      .where(and(eq(appointment.id, id), eq(appointment.doctorId, doctorId))).limit(1);
    if (!patient) throw new NotFoundException('Appointment not found.');
    return patient;
  }

  async reschedule(id: string, actor: AuthenticatedUser, input: AppointmentRescheduleInput) {
    if (actor.role === 'doctor') {
      await this.assertDoctorApproved(actor.role, actor.id);
    } else if (actor.role !== 'patient') {
      throw new ForbiddenException();
    }

    return db.transaction(async (tx) => {
      // Read the doctor id without locking the appointment, then acquire the
      // shared doctor-capacity lock before the appointment row. Schedule-change
      // consent follows the same order, preventing a doctor-lock/appointment-lock
      // cycle between the two rescheduling paths.
      const [candidate] = await tx.select({ doctorId: appointment.doctorId })
        .from(appointment)
        .where(eq(appointment.id, id))
        .limit(1);
      if (!candidate) throw new NotFoundException('Appointment not found.');
      await this.lockDoctorCapacity(tx, candidate.doctorId);

      const [record] = await tx.select().from(appointment)
        .where(eq(appointment.id, id))
        .for('update')
        .limit(1);

      if (!record || !canAccessAppointment(actor.role, actor.id, record)) {
        throw new NotFoundException('Appointment not found.');
      }

      if (record.status !== 'scheduled') {
        throw new ConflictException(`Cannot reschedule an appointment that is already ${record.status}.`);
      }

      const isDoctorApproved = await this.doctors.isApproved(record.doctorId);
      if (!isDoctorApproved) {
        throw new ConflictException('Cannot reschedule appointment because doctor is currently inactive or unapproved.');
      }

      if (
        record.startsAt.getTime() === input.startsAt.getTime() &&
        record.endsAt.getTime() === input.endsAt.getTime()
      ) {
        return record;
      }

      const durationMs = input.endsAt.getTime() - input.startsAt.getTime();
      const originalDurationMs = record.endsAt.getTime() - record.startsAt.getTime();
      if (
        durationMs !== originalDurationMs &&
        durationMs !== 15 * 60 * 1000 &&
        durationMs !== 30 * 60 * 1000
      ) {
        throw new BadRequestException('Appointment duration must be 15 or 30 minutes.');
      }

      const scheduleConfig = this.scheduleService
        ? await this.scheduleService.getScheduleConfigForDoctor(record.doctorId)
        : { timezone: 'Asia/Kolkata', slotDurationMinutes: 30 };
      const timezone = scheduleConfig.timezone ?? 'Asia/Kolkata';
      if (!isBookableSlot(input.startsAt, input.endsAt, new Date(), { ...scheduleConfig, timezone })) {
        throw new BadRequestException('The selected slot is not within the doctor’s available schedule.');
      }
      const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(input.startsAt);
      const capacity = await this.getCapacityForDate(tx, record.doctorId, localDate);
      const now = new Date();
      const occupied = await tx.select({ id: appointment.id }).from(appointment).where(and(
        eq(appointment.doctorId, record.doctorId),
        ne(appointment.id, id),
        or(
          eq(appointment.status, 'scheduled'),
          and(eq(appointment.status, 'pending_payment'), gt(appointment.holdExpiresAt, now)),
        ),
        lt(appointment.startsAt, input.endsAt),
        gt(appointment.endsAt, input.startsAt),
      ));
      if (occupied.length >= capacity) {
        throw new ConflictException('The selected appointment window has reached its booking capacity.');
      }

      try {
        const [updated] = await tx.update(appointment)
          .set({
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            reminderGeneration: sql`${appointment.reminderGeneration} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(appointment.id, id), eq(appointment.status, 'scheduled')))
          .returning({
            id: appointment.id,
            patientId: appointment.patientId,
            doctorId: appointment.doctorId,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            status: appointment.status,
            updatedAt: appointment.updatedAt,
            reminderGeneration: appointment.reminderGeneration,
          });

        if (!updated) {
          throw new ConflictException('Appointment changed concurrently; please refresh.');
        }

        await this.enqueueAppointmentEmails(
          tx,
          'appointment_rescheduled',
          record,
          updated.startsAt,
          randomUUID(),
        );

        const reminderTimezone = await this.scheduleService?.getTimezoneForDoctor(record.doctorId) ?? 'Asia/Kolkata';
        await this.appointmentReminders?.cancelForAppointment(tx, id);
        await this.appointmentReminders?.scheduleForAppointment(tx, updated, reminderTimezone);

        if (this.notifications) {
          const timezone = await this.scheduleService?.getTimezoneForDoctor(record.doctorId);
          const timeFormatted = timezone
            ? new Intl.DateTimeFormat('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: timezone,
              }).format(updated.startsAt)
            : null;

          void this.notifications.createNotification({
            userId: record.patientId,
            title: 'Appointment Rescheduled',
            message: timeFormatted
              ? `Consultation updated to ${timeFormatted} (${timezone}).`
              : 'Your consultation time was updated. Sign in to view the appointment details.',
            type: 'reschedule',
            appointmentId: id,
          });

          void this.notifications.createNotification({
            userId: record.doctorId,
            title: 'Appointment Rescheduled',
            message: timeFormatted
              ? `Patient consultation updated to ${timeFormatted} (${timezone}).`
              : 'The patient consultation time was updated.',
            type: 'reschedule',
            appointmentId: id,
          });
        }

        return updated;
      } catch (err: unknown) {
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23P01') {
          throw new ConflictException('The selected doctor already has a scheduled appointment in that time slot.');
        }
        throw err;
      }
    });
  }

  async getScheduleChangeRequestForPatient(requestId: string, patientId: string) {
    const [request] = await db.select().from(scheduleChangeRequest)
      .where(eq(scheduleChangeRequest.id, requestId))
      .limit(1);
    if (!request || !request.approvedAt) throw new NotFoundException('Approved schedule change request not found.');
    const affected = await db.select({
      affected: scheduleChangeAppointment,
      appointment: {
        id: appointment.id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
      },
    }).from(scheduleChangeAppointment)
      .innerJoin(appointment, eq(appointment.id, scheduleChangeAppointment.appointmentId))
      .where(and(eq(scheduleChangeAppointment.requestId, requestId), eq(appointment.patientId, patientId)));
    if (!affected.length) throw new NotFoundException('Schedule change appointment not found.');
    const alternatives = await db.select().from(scheduleChangeAlternative)
      .where(inArray(scheduleChangeAlternative.affectedAppointmentId, affected.map((row) => row.affected.id)));
    return {
      request,
      affectedAppointments: affected.map(({ affected: item, appointment: record }) => ({
        ...item,
        appointment: record,
        alternatives: alternatives.filter((alternative) => alternative.affectedAppointmentId === item.id),
      })),
    };
  }

  async listScheduleChangeRequestsForPatient(patientId: string) {
    const eligible = await db.select({ requestId: scheduleChangeRequest.id })
      .from(scheduleChangeAppointment)
      .innerJoin(appointment, eq(appointment.id, scheduleChangeAppointment.appointmentId))
      .innerJoin(scheduleChangeRequest, eq(scheduleChangeRequest.id, scheduleChangeAppointment.requestId))
      .where(and(
        eq(appointment.patientId, patientId),
        isNotNull(scheduleChangeRequest.approvedAt),
      ))
      .orderBy(desc(scheduleChangeRequest.createdAt));
    const requestIds = [...new Set(eligible.map(({ requestId }) => requestId))];
    return Promise.all(requestIds.map((requestId) =>
      this.getScheduleChangeRequestForPatient(requestId, patientId)));
  }

  async acceptScheduleChange(
    requestId: string,
    affectedAppointmentId: string,
    alternativeId: string,
    patientId: string,
  ) {
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [candidate] = await tx.select({
        appointmentId: scheduleChangeAppointment.appointmentId,
      }).from(scheduleChangeAppointment)
        .where(and(eq(scheduleChangeAppointment.id, affectedAppointmentId), eq(scheduleChangeAppointment.requestId, requestId)))
        .limit(1);
      if (!candidate) throw new NotFoundException('Schedule change appointment not found.');
      const [candidateAppointment] = await tx.select({ doctorId: appointment.doctorId })
        .from(appointment).where(eq(appointment.id, candidate.appointmentId)).limit(1);
      if (!candidateAppointment) throw new NotFoundException('Appointment not found.');
      await this.lockDoctorCapacity(tx, candidateAppointment.doctorId);
      const [request] = await tx.select().from(scheduleChangeRequest)
        .where(eq(scheduleChangeRequest.id, requestId)).for('update').limit(1);
      if (!request || request.status !== 'pending' || !request.approvedAt) {
        throw new ConflictException('This schedule change is not approved for patient consent.');
      }
      if (request.doctorId !== candidateAppointment.doctorId) {
        throw new ForbiddenException('Schedule change request does not belong to this appointment.');
      }
      if (request.expiresAt.getTime() <= now.getTime()) {
        throw new ConflictException('The schedule change request has expired.');
      }
      const [affected] = await tx.select().from(scheduleChangeAppointment)
        .where(and(eq(scheduleChangeAppointment.id, affectedAppointmentId), eq(scheduleChangeAppointment.requestId, requestId)))
        .for('update').limit(1);
      if (!affected) throw new NotFoundException('Schedule change appointment not found.');
      if (affected.consentStatus !== 'pending' || affected.resolutionStatus !== 'pending') {
        throw new ConflictException('This appointment already has a recorded response.');
      }
      await tx.select({ id: payment.id }).from(payment)
        .where(eq(payment.appointmentId, affected.appointmentId))
        .for('update').limit(1);
      const [record] = await tx.select().from(appointment)
        .where(and(eq(appointment.id, affected.appointmentId), eq(appointment.patientId, patientId)))
        .for('update').limit(1);
      if (!record) throw new NotFoundException('Appointment not found.');
      if (record.startsAt.getTime() !== affected.originalStartsAt.getTime()
        || record.endsAt.getTime() !== affected.originalEndsAt.getTime()) {
        throw new ConflictException('The appointment changed before patient consent was recorded.');
      }
      const [alternative] = await tx.select().from(scheduleChangeAlternative)
        .where(and(eq(scheduleChangeAlternative.id, alternativeId), eq(scheduleChangeAlternative.affectedAppointmentId, affectedAppointmentId)))
        .limit(1);
      if (!alternative) throw new BadRequestException('Selected alternative does not belong to this appointment.');

      const parsedSchedule = doctorScheduleUpdateSchema.safeParse(request.proposedSchedule);
      if (!parsedSchedule.success) throw new ConflictException('The stored schedule proposal is invalid.');
      const current = this.scheduleService
        ? await this.scheduleService.getScheduleConfigForDoctor(record.doctorId)
        : { timezone: 'Asia/Kolkata', slotDurationMinutes: 30 };
      const proposed = { ...current, ...parsedSchedule.data };
      const capacityWindow = getBookableRescheduleWindow(alternative.startsAt, alternative.endsAt, now, proposed);
      if (!capacityWindow) {
        throw new ConflictException('The selected alternative is no longer available.');
      }
      const localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: proposed.timezone ?? 'Asia/Kolkata',
      }).format(alternative.startsAt);
      const publishedCapacity = await this.getCapacityForDate(tx, record.doctorId, localDate);
      const override = proposed.dateOverrides?.find((entry) => entry.date === localDate);
      const capacity = override?.capacity ?? proposed.capacity ?? publishedCapacity;
      const occupied = await tx.select({ id: appointment.id }).from(appointment).where(and(
        eq(appointment.doctorId, record.doctorId),
        ne(appointment.id, record.id),
        or(eq(appointment.status, 'scheduled'), and(eq(appointment.status, 'pending_payment'), gt(appointment.holdExpiresAt, now))),
        lt(appointment.startsAt, capacityWindow.endsAt),
        gt(appointment.endsAt, capacityWindow.startsAt),
      ));
      if (occupied.length >= capacity) throw new ConflictException('The selected alternative has reached capacity.');
      const [updated] = await tx.update(appointment).set({
        startsAt: alternative.startsAt,
        endsAt: alternative.endsAt,
        reminderGeneration: sql`${appointment.reminderGeneration} + 1`,
        updatedAt: now,
      }).where(and(
        eq(appointment.id, record.id),
        eq(appointment.startsAt, affected.originalStartsAt),
        eq(appointment.endsAt, affected.originalEndsAt),
        or(eq(appointment.status, 'scheduled'), eq(appointment.status, 'pending_payment')),
      )).returning();
      if (!updated) throw new ConflictException('Appointment changed concurrently; please refresh.');
      await tx.insert(appointmentHistory).values({
        id: randomUUID(),
        appointmentId: record.id,
        actorId: patientId,
        action: 'schedule_change_rescheduled',
        previousStartsAt: record.startsAt,
        previousEndsAt: record.endsAt,
        newStartsAt: alternative.startsAt,
        newEndsAt: alternative.endsAt,
        reason: 'Patient accepted an approved schedule-change alternative.',
        createdAt: now,
      });
      const [resolved] = await tx.update(scheduleChangeAppointment).set({
        consentStatus: 'accepted',
        resolutionStatus: 'rescheduled',
        selectedAlternativeId: alternative.id,
        respondedAt: now,
        resolvedAt: now,
        updatedAt: now,
      }).where(and(
        eq(scheduleChangeAppointment.id, affectedAppointmentId),
        eq(scheduleChangeAppointment.consentStatus, 'pending'),
        eq(scheduleChangeAppointment.resolutionStatus, 'pending'),
      )).returning();
      if (!resolved) throw new ConflictException('Schedule-change consent changed concurrently.');
      if (this.notifications) {
        void this.notifications.createNotification({
          userId: record.doctorId,
          title: 'Patient accepted a schedule alternative',
          message: `The patient accepted a new time for appointment ${record.id}.`,
          type: 'reschedule',
          appointmentId: record.id,
          scheduleRequestId: requestId,
        });
      }
      await this.enqueueAppointmentEmails(tx, 'appointment_rescheduled', record, updated.startsAt, randomUUID());
      await this.appointmentReminders?.cancelForAppointment(tx, record.id);
      await this.appointmentReminders?.scheduleForAppointment(tx, updated, proposed.timezone ?? 'Asia/Kolkata');
      return updated;
    });
    await this.scheduleService?.finalizeScheduleRequest(updated.doctorId, requestId);
    return updated;
  }

  async declineScheduleChange(requestId: string, affectedAppointmentId: string, patientId: string, reason?: string) {
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      const [candidate] = await tx.select({
        appointmentId: scheduleChangeAppointment.appointmentId,
      }).from(scheduleChangeAppointment)
        .where(and(eq(scheduleChangeAppointment.id, affectedAppointmentId), eq(scheduleChangeAppointment.requestId, requestId)))
        .limit(1);
      if (!candidate) throw new NotFoundException('Schedule change appointment not found.');
      const [candidateAppointment] = await tx.select({ doctorId: appointment.doctorId })
        .from(appointment).where(eq(appointment.id, candidate.appointmentId)).limit(1);
      if (!candidateAppointment) throw new NotFoundException('Appointment not found.');
      await this.lockDoctorCapacity(tx, candidateAppointment.doctorId);
      const [request] = await tx.select().from(scheduleChangeRequest)
        .where(eq(scheduleChangeRequest.id, requestId)).for('update').limit(1);
      if (!request || request.status !== 'pending' || !request.approvedAt) {
        throw new ConflictException('This schedule change is not available for patient response.');
      }
      if (request.doctorId !== candidateAppointment.doctorId) {
        throw new ForbiddenException('Schedule change request does not belong to this appointment.');
      }
      if (request.expiresAt.getTime() <= now.getTime()) throw new ConflictException('The schedule change request has expired.');
      const [affected] = await tx.select().from(scheduleChangeAppointment)
        .where(and(eq(scheduleChangeAppointment.id, affectedAppointmentId), eq(scheduleChangeAppointment.requestId, requestId)))
        .for('update').limit(1);
      if (!affected) throw new NotFoundException('Schedule change appointment not found.');
      if (affected.consentStatus !== 'pending' || affected.resolutionStatus !== 'pending') {
        throw new ConflictException('This appointment already has a recorded response.');
      }
      const [record] = await tx.select({
        id: appointment.id,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
      }).from(appointment)
        .where(and(eq(appointment.id, affected.appointmentId), eq(appointment.patientId, patientId)))
        .for('update').limit(1);
      if (!record) throw new NotFoundException('Appointment not found.');
      const [resolved] = await tx.update(scheduleChangeAppointment).set({
        consentStatus: 'declined',
        resolutionStatus: 'cancelled',
        respondedAt: now,
        responseReason: reason ?? null,
        updatedAt: now,
      }).where(and(eq(scheduleChangeAppointment.id, affectedAppointmentId), eq(scheduleChangeAppointment.consentStatus, 'pending'))).returning();
      if (!resolved) throw new ConflictException('Schedule-change consent changed concurrently.');
      if (this.notifications) {
        void this.notifications.createNotification({
          userId: record.patientId,
          title: 'Schedule change declined',
          message: 'Your response was recorded. Your appointment remains at its current time.',
          type: 'reschedule',
          appointmentId: record.id,
          scheduleRequestId: requestId,
        });
        void this.notifications.createNotification({
          userId: record.doctorId,
          title: 'Patient declined a schedule alternative',
          message: `The patient declined an alternative for appointment ${record.id}.`,
          type: 'reschedule',
          appointmentId: record.id,
          scheduleRequestId: requestId,
        });
      }
      return { resolved, doctorId: record.doctorId };
    });
    await this.scheduleService?.finalizeScheduleRequest(outcome.doctorId, requestId);
    return outcome.resolved;
  }

  async cancelUnresolvedScheduleChange(
    requestId: string,
    affectedAppointmentId: string,
    doctorId: string,
    reason: string,
  ) {
    await this.assertDoctorApproved('doctor', doctorId);
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      // Lock order: doctor profile -> request -> affected appointment -> payment -> appointment.
      // Patient acceptance follows the same order, so only one path can resolve the item.
      await this.lockDoctorCapacity(tx, doctorId);
      const [affected] = await tx.select().from(scheduleChangeAppointment)
        .where(and(
          eq(scheduleChangeAppointment.id, affectedAppointmentId),
          eq(scheduleChangeAppointment.requestId, requestId),
        )).limit(1);
      if (!affected) throw new NotFoundException('Schedule change appointment not found.');

      const [request] = await tx.select().from(scheduleChangeRequest)
        .where(and(eq(scheduleChangeRequest.id, requestId), eq(scheduleChangeRequest.doctorId, doctorId)))
        .for('update').limit(1);
      if (!request || request.status !== 'pending') {
        throw new ConflictException('Only pending requests can be cancelled.');
      }
      if (request.expiresAt.getTime() <= now.getTime()) {
        throw new ConflictException('The schedule change request has expired.');
      }
      if (affected.consentStatus !== 'pending' || affected.resolutionStatus !== 'pending') {
        throw new ConflictException('Only unresolved appointments in a pending request can be cancelled.');
      }
      const [lockedAffected] = await tx.select().from(scheduleChangeAppointment)
        .where(eq(scheduleChangeAppointment.id, affectedAppointmentId))
        .for('update').limit(1);
      if (!lockedAffected || lockedAffected.consentStatus !== 'pending' || lockedAffected.resolutionStatus !== 'pending') {
        throw new ConflictException('Only unresolved appointments in a pending request can be cancelled.');
      }

      const cancelled = await this.cancelAppointmentInTransaction(tx, lockedAffected.appointmentId, {
        id: doctorId,
        role: 'doctor',
        name: '',
        email: '',
      });

      const [resolved] = await tx.update(scheduleChangeAppointment).set({
        consentStatus: 'declined',
        resolutionStatus: 'cancelled',
        respondedAt: now,
        resolvedAt: now,
        responseReason: reason,
        updatedAt: now,
      }).where(and(
        eq(scheduleChangeAppointment.id, affectedAppointmentId),
        eq(scheduleChangeAppointment.consentStatus, 'pending'),
        eq(scheduleChangeAppointment.resolutionStatus, 'pending'),
      )).returning();
      if (!resolved) throw new ConflictException('Schedule-change appointment changed concurrently.');
      await tx.insert(appointmentHistory).values({
        id: randomUUID(),
        appointmentId: lockedAffected.appointmentId,
        actorId: doctorId,
        action: 'schedule_change_cancelled',
        reason,
        createdAt: now,
      });
      return { ...cancelled, resolved };
    });

    await this.notifyAppointmentCancelled(outcome.record, outcome.updated.id);
    const refund = await this.processCancellationRefund(
      doctorId,
      outcome.updated.id,
      outcome.paymentIdToRefund,
      outcome.remainingPaise,
      'doctor',
    );
    await this.scheduleService?.finalizeScheduleRequest(doctorId, requestId);
    return {
      appointment: { ...outcome.updated, refund },
      scheduleChangeAppointment: outcome.resolved,
    };
  }

  async cancel(id: string, actor: AuthenticatedUser) {
    if (actor.role === 'doctor') {
      await this.assertDoctorApproved(actor.role, actor.id);
    } else if (actor.role !== 'patient') {
      throw new ForbiddenException();
    }

    const { updated, record, paymentIdToRefund, remainingPaise } = await db.transaction(async (tx) => {
      return this.cancelAppointmentInTransaction(tx, id, actor);
    });

    await this.notifyAppointmentCancelled(record, id);
    const refundResult = await this.processCancellationRefund(
      actor.id,
      id,
      paymentIdToRefund,
      remainingPaise,
      actor.role,
    );

    return {
      ...updated,
      refund: refundResult ?? null,
    };
  }

  private async cancelAppointmentInTransaction(
    tx: AppointmentTransaction,
    id: string,
    actor: AuthenticatedUser,
  ) {
      // 1. Lock payment row FIRST to guarantee consistent global lock order (payment -> appointment) with verifyPayment and webhook
      const [payRecord] = await tx
        .select({
          id: payment.id,
          status: payment.status,
          amountPaise: payment.amountPaise,
          refundedAmountPaise: payment.refundedAmountPaise,
        })
        .from(payment)
        .where(eq(payment.appointmentId, id))
        .for('update')
        .limit(1);

      // 2. Lock appointment row SECOND
      const [record] = await tx.select().from(appointment)
        .where(eq(appointment.id, id))
        .for('update')
        .limit(1);

      if (!record || !canAccessAppointment(actor.role, actor.id, record)) {
        throw new NotFoundException('Appointment not found.');
      }

      if (record.status !== 'scheduled' && record.status !== 'pending_payment') {
        throw new ConflictException(`Cannot cancel an appointment that is already ${record.status}.`);
      }

      const [updated] = await tx.update(appointment)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(appointment.id, id), or(eq(appointment.status, 'scheduled'), eq(appointment.status, 'pending_payment'))))
        .returning({ id: appointment.id, status: appointment.status, updatedAt: appointment.updatedAt });

      if (!updated) {
        throw new ConflictException('Appointment changed concurrently; please refresh.');
      }

      let paymentIdToRefund: string | null = null;
      let remainingPaise = 0;

      if (payRecord) {
        if (payRecord.status === 'created') {
          // Unpaid hold: mark payment as failed so it cannot be completed later
          await tx
            .update(payment)
            .set({
              status: 'failed',
              failureReason: `Appointment cancelled by ${actor.role}`,
              updatedAt: new Date(),
            })
            .where(eq(payment.id, payRecord.id));
        } else if (payRecord.status === 'captured') {
          const refundable = payRecord.amountPaise - (payRecord.refundedAmountPaise ?? 0);
          if (refundable > 0) {
            paymentIdToRefund = payRecord.id;
            remainingPaise = refundable;
          }
        }
      }

      await this.enqueueAppointmentEmails(tx, 'appointment_cancelled', record, record.startsAt, 'cancelled');
      await this.appointmentReminders?.cancelForAppointment(tx, id);

      return { updated, record, paymentIdToRefund, remainingPaise };
  }

  private async notifyAppointmentCancelled(
    record: { patientId: string; doctorId: string },
    appointmentId: string,
  ): Promise<void> {
    if (this.notifications) {
      void this.notifications.createNotification({
        userId: record.patientId,
        title: 'Appointment Cancelled',
        message: 'Appointment was cancelled and the time slot was released.',
        type: 'cancellation',
        appointmentId,
      });

      void this.notifications.createNotification({
        userId: record.doctorId,
        title: 'Appointment Cancelled',
        message: 'A patient consultation was cancelled and the slot was released.',
        type: 'cancellation',
        appointmentId,
      });
    }
  }

  private async processCancellationRefund(
    actorId: string,
    appointmentId: string,
    paymentIdToRefund: string | null,
    remainingPaise: number,
    actorRole: 'doctor' | 'patient',
  ) {
    let refundResult = null;
    if (paymentIdToRefund) {
      if (!this.payments) {
        const errorMsg = `PaymentsService is required to process refund for cancelled appointment ${appointmentId} (payment: ${paymentIdToRefund}), but no PaymentsService instance was provided.`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }
      try {
        refundResult = await this.payments.refundPayment(
          actorId,
          'system',
          paymentIdToRefund,
          {
            reason: `Appointment cancelled by ${actorRole}`,
            amountPaise: remainingPaise,
          },
        );
      } catch (err: any) {
        this.logger.error(
          `Immediate refund failed for cancelled appointment ${appointmentId} (payment: ${paymentIdToRefund}): ${err?.message}`,
          err?.stack,
        );
        // Note: Do not throw. Appointment is safely cancelled;
        // background PaymentReconciliationService will catch and retry unrefunded balance.
      }
    }

    return refundResult;
  }

  async complete(id: string, actor: AuthenticatedUser) {
    if (actor.role !== 'doctor') {
      throw new ForbiddenException('Only doctors can complete appointments.');
    }
    await this.assertDoctorApproved(actor.role, actor.id);

    return db.transaction(async (tx) => {
      const [record] = await tx.select().from(appointment)
        .where(eq(appointment.id, id))
        .for('update')
        .limit(1);

      if (!record || record.doctorId !== actor.id) {
        throw new NotFoundException('Appointment not found.');
      }

      if (record.status !== 'scheduled') {
        throw new ConflictException(`Cannot complete an appointment that is ${record.status}.`);
      }

      const [updated] = await tx.update(appointment)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(and(eq(appointment.id, id), eq(appointment.status, 'scheduled')))
        .returning({ id: appointment.id, status: appointment.status, updatedAt: appointment.updatedAt });

      if (!updated) {
        throw new ConflictException('Appointment changed concurrently; please refresh.');
      }

      await this.appointmentReminders?.cancelForAppointment(tx, id);

      if (this.notifications) {
        void this.notifications.createNotification({
          userId: record.patientId,
          title: 'Consultation Completed',
          message: 'Your consultation has concluded. We hope you had a great care experience.',
          type: 'completion',
          appointmentId: id,
        });
      }

      return updated;
    });
  }

  private async assertDoctorApproved(role: UserRole, userId: string): Promise<void> {
    if (role === 'doctor' && !(await this.doctors.isApproved(userId))) throw new ForbiddenException();
  }

  private async findApprovedDoctor(profileId: string) {
    const [doctor] = await db.select({ userId: doctorProfile.userId }).from(doctorProfile)
      .innerJoin(user, eq(user.id, doctorProfile.userId))
      .where(and(eq(doctorProfile.id, profileId), eq(doctorProfile.status, 'approved'), eq(user.role, 'doctor')))
      .limit(1);
    return doctor;
  }
}
