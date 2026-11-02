import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, gt, inArray, lt, lte, or } from 'drizzle-orm';
import type { AuthenticatedUser, UserRole } from '../auth/authenticated-user.js';
import { db } from '../db/database.js';
import { appointment, doctorProfile, payment, refund, user } from '../db/schema.js';
import { DoctorProfilesService } from '../doctors/doctor-profiles.service.js';
import { DoctorScheduleService } from '../doctors/doctor-schedule.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PaymentReconciliationService } from '../payments/payment-reconciliation.service.js';
import { canAccessAppointment } from './appointment-access.js';
import { createWithConflictHandling } from './appointment-conflict.js';
import { createZonedDate, getAvailableSlots, isBookableSlot } from './appointment-availability.js';
import type { AppointmentAvailabilityQuery } from './appointment-availability.schema.js';
import type { z } from 'zod';
import type { appointmentBookingSchema } from './appointment-booking.schema.js';
import type { AppointmentRescheduleInput } from './appointment-reschedule.schema.js';
import { randomUUID } from 'node:crypto';

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
  ) {}

  async getAvailableSlots(patientId: string, input: AppointmentAvailabilityQuery) {
    const doctor = await this.findApprovedDoctor(input.doctorProfileId);
    if (!doctor) throw new NotFoundException('Approved doctor not found.');
    if (doctor.userId === patientId) throw new ForbiddenException();

    const scheduleConfig = this.scheduleService
      ? await this.scheduleService.getScheduleConfigForProfile(input.doctorProfileId)
      : { timezone: 'Asia/Kolkata', slotDurationMinutes: 30 };

    const tz = scheduleConfig.timezone ?? 'Asia/Kolkata';
    const dayStart = createZonedDate(input.date, 0, 0, tz);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
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

    const slots = getAvailableSlots(input.date, busy, now, {
      ...scheduleConfig,
      timezone: tz,
    });

    return {
      doctorProfileId: input.doctorProfileId,
      date: input.date,
      timezone: tz,
      durationMinutes: scheduleConfig.slotDurationMinutes ?? 30,
      slots: slots.map(({ startsAt, endsAt }) => ({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() })),
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

    const now = new Date();

    // 1. Check for overlapping scheduled or active held appointments
    const busy = await db.select({ id: appointment.id })
      .from(appointment)
      .where(and(
        eq(appointment.doctorId, doctor.userId),
        or(
          eq(appointment.status, 'scheduled'),
          and(
            eq(appointment.status, 'pending_payment'),
            gt(appointment.holdExpiresAt, now),
          ),
        ),
        lt(appointment.startsAt, input.endsAt),
        gt(appointment.endsAt, input.startsAt),
      ))
      .limit(1);

    if (busy.length > 0) {
      throw new ConflictException('The selected doctor already has a scheduled appointment in that time slot.');
    }

    // 2. Clean up any expired pending_payment hold in this slot before inserting new hold
    await db.update(appointment)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(appointment.doctorId, doctor.userId),
        eq(appointment.status, 'pending_payment'),
        lte(appointment.holdExpiresAt, now),
        lt(appointment.startsAt, input.endsAt),
        gt(appointment.endsAt, input.startsAt),
      ));

    // 3. Create atomic 10-minute hold with database exclusion constraint protection
    const holdExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);

    return createWithConflictHandling(async () => {
      const [created] = await db.insert(appointment).values({
        id: randomUUID(),
        patientId,
        doctorId: doctor.userId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: 'pending_payment',
        holdExpiresAt,
      }).returning({
        id: appointment.id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
        holdExpiresAt: appointment.holdExpiresAt,
      });

      return created;
    });
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

      try {
        const [updated] = await tx.update(appointment)
          .set({
            startsAt: input.startsAt,
            endsAt: input.endsAt,
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
          });

        if (!updated) {
          throw new ConflictException('Appointment changed concurrently; please refresh.');
        }

        if (this.notifications) {
          const timeFormatted = new Intl.DateTimeFormat('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Asia/Kolkata',
          }).format(input.startsAt);

          void this.notifications.createNotification({
            userId: record.patientId,
            title: 'Appointment Rescheduled',
            message: `Consultation updated to ${timeFormatted} IST.`,
            type: 'reschedule',
            appointmentId: id,
          });

          void this.notifications.createNotification({
            userId: record.doctorId,
            title: 'Appointment Rescheduled',
            message: `Patient consultation updated to ${timeFormatted} IST.`,
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

  async cancel(id: string, actor: AuthenticatedUser) {
    if (actor.role === 'doctor') {
      await this.assertDoctorApproved(actor.role, actor.id);
    } else if (actor.role !== 'patient') {
      throw new ForbiddenException();
    }

    const { updated, record, paymentIdToRefund, remainingPaise } = await db.transaction(async (tx) => {
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

      return { updated, record, paymentIdToRefund, remainingPaise };
    });

    if (this.notifications) {
      void this.notifications.createNotification({
        userId: record.patientId,
        title: 'Appointment Cancelled',
        message: 'Appointment was cancelled and the time slot was released.',
        type: 'cancellation',
        appointmentId: id,
      });

      void this.notifications.createNotification({
        userId: record.doctorId,
        title: 'Appointment Cancelled',
        message: 'A patient consultation was cancelled and the slot was released.',
        type: 'cancellation',
        appointmentId: id,
      });
    }

    // Trigger immediate refund for paid appointment outside of DB transaction
    let refundResult = null;
    if (paymentIdToRefund) {
      if (!this.payments) {
        const errorMsg = `PaymentsService is required to process refund for cancelled appointment ${id} (payment: ${paymentIdToRefund}), but no PaymentsService instance was provided.`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }
      try {
        refundResult = await this.payments.refundPayment(
          actor.id,
          'system',
          paymentIdToRefund,
          {
            reason: `Appointment cancelled by ${actor.role}`,
            amountPaise: remainingPaise,
          },
        );
      } catch (err: any) {
        this.logger.error(
          `Immediate refund failed for cancelled appointment ${id} (payment: ${paymentIdToRefund}): ${err?.message}`,
          err?.stack,
        );
        // Note: Do not throw. Appointment is safely cancelled;
        // background PaymentReconciliationService will catch and retry unrefunded balance.
      }
    }

    return {
      ...updated,
      refund: refundResult ?? null,
    };
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
