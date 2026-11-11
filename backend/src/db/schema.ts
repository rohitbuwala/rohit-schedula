import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRole = pgEnum('user_role', ['patient', 'doctor', 'admin']);
export const doctorProfileStatus = pgEnum('doctor_profile_status', ['pending', 'approved', 'rejected']);
export const appointmentStatus = pgEnum('appointment_status', [
  'pending_payment',
  'scheduled',
  'cancelled',
  'completed',
]);
export type AppointmentStatus = typeof appointmentStatus.enumValues[number];

export const paymentStatus = pgEnum('payment_status', [
  'created',
  'captured',
  'failed',
  'refunded',
]);
export type PaymentStatus = typeof paymentStatus.enumValues[number];

export const refundStatus = pgEnum('refund_status', [
  'pending',
  'processed',
  'failed',
]);
export type RefundStatus = typeof refundStatus.enumValues[number];

export const scheduleChangeRequestStatus = pgEnum('schedule_change_request_status', [
  'pending',
  'published',
  'expired',
  'cancelled',
]);
export type ScheduleChangeRequestStatus = typeof scheduleChangeRequestStatus.enumValues[number];

export const scheduleChangeConsentStatus = pgEnum('schedule_change_consent_status', [
  'pending',
  'accepted',
  'declined',
  'expired',
]);
export type ScheduleChangeConsentStatus = typeof scheduleChangeConsentStatus.enumValues[number];

export const scheduleChangeResolutionStatus = pgEnum('schedule_change_resolution_status', [
  'pending',
  'rescheduled',
  'cancelled',
  'expired',
]);
export type ScheduleChangeResolutionStatus = typeof scheduleChangeResolutionStatus.enumValues[number];

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: userRole('role').notNull().default('patient'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const doctorProfile = pgTable('doctor_profile', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  specialty: text('specialty').notNull(),
  licenseRegion: text('license_region').notNull(),
  licenseNumber: text('license_number').notNull(),
  bio: text('bio'),
  // Extended profile fields
  phone: text('phone'),
  qualifications: text('qualifications'),
  yearsOfExperience: integer('years_of_experience'),
  consultationFeeInr: integer('consultation_fee_inr'),
  clinicName: text('clinic_name'),
  clinicAddress: text('clinic_address'),
  profilePhotoUrl: text('profile_photo_url'),
  status: doctorProfileStatus('status').notNull().default('pending'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'restrict' }),
}, (table) => [
  uniqueIndex('doctor_profile_license_unique').on(table.licenseRegion, table.licenseNumber),
  index('doctor_profile_status_submitted_idx').on(table.status, table.submittedAt),
  check('doctor_profile_review_state_check', sql`(${table.status} = 'pending' and ${table.reviewedAt} is null and ${table.reviewedBy} is null) or (${table.status} <> 'pending' and ${table.reviewedAt} is not null and ${table.reviewedBy} is not null)`),
  check('doctor_profile_fee_non_negative_check', sql`${table.consultationFeeInr} is null or ${table.consultationFeeInr} >= 0`),
  check('doctor_profile_experience_non_negative_check', sql`${table.yearsOfExperience} is null or ${table.yearsOfExperience} >= 0`),
]);

export const appointment = pgTable('appointment', {
  id: text('id').primaryKey(),
  patientId: text('patient_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  doctorId: text('doctor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: appointmentStatus('status').notNull().default('scheduled'),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  reminderGeneration: integer('reminder_generation').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('appointment_patient_start_idx').on(table.patientId, table.startsAt),
  index('appointment_doctor_start_idx').on(table.doctorId, table.startsAt),
  index('appointment_status_hold_idx').on(table.status, table.holdExpiresAt),
  check('appointment_distinct_participants_check', sql`${table.patientId} <> ${table.doctorId}`),
  check('appointment_time_order_check', sql`${table.endsAt} > ${table.startsAt}`),
]);

export const patientProfile = pgTable('patient_profile', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  dateOfBirth: text('date_of_birth'),
  gender: text('gender'),
  phone: text('phone'),
  bloodGroup: text('blood_group'),
  address: text('address'),
  allergies: text('allergies'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('patient_profile_user_idx').on(table.userId),
]);

export const doctorAvailability = pgTable('doctor_availability', {
  id: text('id').primaryKey(),
  doctorId: text('doctor_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull().default('UTC'),
  activeDays: integer('active_days').array().notNull().default([1, 2, 3, 4, 5]),
  startHour: integer('start_hour').notNull().default(9),
  endHour: integer('end_hour').notNull().default(17),
  slotDurationMinutes: integer('slot_duration_minutes').notNull().default(30),
  schedulingMode: text('scheduling_mode').notNull().default('stream'),
  capacity: integer('capacity').notNull().default(1),
  breakStart: text('break_start'),
  breakEnd: text('break_end'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('doctor_availability_scheduling_mode_check', sql`${table.schedulingMode} in ('wave', 'stream')`),
  check('doctor_availability_capacity_check', sql`${table.capacity} > 0`),
]);

export const doctorLeave = pgTable('doctor_leave', {
  id: text('id').primaryKey(),
  doctorId: text('doctor_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('doctor_leave_doctor_date_unique').on(table.doctorId, table.date),
  index('doctor_leave_doctor_date_idx').on(table.doctorId, table.date),
]);

export const doctorScheduleOverride = pgTable('doctor_schedule_override', {
  id: text('id').primaryKey(),
  doctorId: text('doctor_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  startHour: integer('start_hour').notNull(),
  endHour: integer('end_hour').notNull(),
  slotDurationMinutes: integer('slot_duration_minutes').notNull().default(30),
  schedulingMode: text('scheduling_mode'),
  capacity: integer('capacity'),
  breakStart: text('break_start'),
  breakEnd: text('break_end'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('doctor_schedule_override_doctor_date_unique').on(table.doctorId, table.date),
  index('doctor_schedule_override_doctor_date_idx').on(table.doctorId, table.date),
  check('doctor_schedule_override_hour_check', sql`${table.startHour} >= 0 and ${table.endHour} <= 24 and ${table.endHour} > ${table.startHour}`),
  check('doctor_schedule_override_duration_check', sql`${table.slotDurationMinutes} in (15, 30)`),
  check('doctor_schedule_override_date_check', sql`${table.date} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  check('doctor_schedule_override_mode_check', sql`${table.schedulingMode} is null or ${table.schedulingMode} in ('wave', 'stream')`),
  check('doctor_schedule_override_capacity_check', sql`${table.capacity} is null or ${table.capacity} > 0`),
]);

export const payment = pgTable('payment', {
  id: text('id').primaryKey(),
  appointmentId: text('appointment_id').notNull().references(() => appointment.id, { onDelete: 'cascade' }),
  patientId: text('patient_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  doctorId: text('doctor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  razorpayOrderId: text('razorpay_order_id').notNull().unique(),
  razorpayPaymentId: text('razorpay_payment_id').unique(),
  razorpaySignature: text('razorpay_signature'),
  amountPaise: integer('amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: paymentStatus('status').notNull().default('created'),
  receipt: text('receipt').notNull(),
  failureReason: text('failure_reason'),
  refundedAmountPaise: integer('refunded_amount_paise').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('payment_appointment_idx').on(table.appointmentId),
  index('payment_patient_idx').on(table.patientId),
  index('payment_doctor_idx').on(table.doctorId),
  index('payment_status_idx').on(table.status),
  index('payment_order_idx').on(table.razorpayOrderId),
  check('payment_amount_positive_check', sql`${table.amountPaise} > 0`),
  check('payment_refunded_amount_check', sql`${table.refundedAmountPaise} >= 0 and ${table.refundedAmountPaise} <= ${table.amountPaise}`),
]);

export const refund = pgTable('refund', {
  id: text('id').primaryKey(),
  paymentId: text('payment_id').notNull().references(() => payment.id, { onDelete: 'cascade' }),
  appointmentId: text('appointment_id').notNull().references(() => appointment.id, { onDelete: 'cascade' }),
  patientId: text('patient_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  doctorId: text('doctor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  razorpayPaymentId: text('razorpay_payment_id').notNull(),
  razorpayRefundId: text('razorpay_refund_id').unique(),
  amountPaise: integer('amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: refundStatus('status').notNull().default('pending'),
  reason: text('reason').notNull(),
  arn: text('arn'),
  notes: text('notes'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('refund_payment_idx').on(table.paymentId),
  index('refund_appointment_idx').on(table.appointmentId),
  index('refund_patient_idx').on(table.patientId),
  index('refund_doctor_idx').on(table.doctorId),
  index('refund_status_idx').on(table.status),
  index('refund_razorpay_refund_idx').on(table.razorpayRefundId),
  check('refund_amount_positive_check', sql`${table.amountPaise} > 0`),
]);

export const emailOutbox = pgTable('email_outbox', {
  id: text('id').primaryKey(),
  eventKey: text('event_key').notNull(),
  eventType: text('event_type').notNull(),
  recipient: text('recipient').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  appointmentId: text('appointment_id').references(() => appointment.id, { onDelete: 'set null' }),
  paymentId: text('payment_id').references(() => payment.id, { onDelete: 'set null' }),
  refundId: text('refund_id').references(() => refund.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
  lastError: text('last_error'),
  processingAt: timestamp('processing_at', { withTimezone: true }),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('email_outbox_event_key_unique').on(table.eventKey),
  index('email_outbox_pending_idx').on(table.status, table.nextAttemptAt),
  index('email_outbox_lease_idx').on(table.status, table.leaseExpiresAt),
  index('email_outbox_retention_idx').on(table.status, table.sentAt, table.updatedAt),
  check('email_outbox_event_type_check', sql`${table.eventType} in ('booking_confirmation', 'payment_receipt', 'appointment_cancelled', 'appointment_rescheduled', 'refund_processed')`),
  check('email_outbox_status_check', sql`${table.status} in ('pending', 'processing', 'sent', 'dead')`),
  check('email_outbox_attempt_count_check', sql`${table.attemptCount} >= 0`),
]);

export const appointmentReminder = pgTable('appointment_reminder', {
  id: text('id').primaryKey(),
  appointmentId: text('appointment_id').notNull().references(() => appointment.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  recipientEmail: text('recipient_email').notNull(),
  recipientName: text('recipient_name').notNull(),
  otherPartyName: text('other_party_name').notNull(),
  intervalMinutes: integer('interval_minutes').notNull(),
  appointmentStartsAt: timestamp('appointment_starts_at', { withTimezone: true }).notNull(),
  generation: integer('generation').notNull(),
  timezone: text('timezone').notNull(),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
  lastError: text('last_error'),
  processingAt: timestamp('processing_at', { withTimezone: true }),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('appointment_reminder_identity_unique').on(
    table.appointmentId, table.recipientId, table.intervalMinutes, table.generation,
  ),
  index('appointment_reminder_due_idx').on(table.status, table.nextAttemptAt, table.scheduledFor),
  index('appointment_reminder_lease_idx').on(table.status, table.leaseExpiresAt),
  index('appointment_reminder_appointment_status_idx').on(table.appointmentId, table.status),
  index('appointment_reminder_retention_idx').on(table.status, table.sentAt, table.updatedAt),
  check('appointment_reminder_interval_check', sql`${table.intervalMinutes} in (60, 1440)`),
  check('appointment_reminder_status_check', sql`${table.status} in ('pending', 'processing', 'sent', 'cancelled', 'dead')`),
  check('appointment_reminder_attempt_count_check', sql`${table.attemptCount} >= 0`),
]);

export const scheduleChangeRequest = pgTable('schedule_change_request', {
  id: text('id').primaryKey(),
  doctorId: text('doctor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  proposedSchedule: jsonb('proposed_schedule').$type<Record<string, unknown>>().notNull(),
  status: scheduleChangeRequestStatus('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: text('approved_by').references(() => user.id, { onDelete: 'restrict' }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: text('cancelled_by').references(() => user.id, { onDelete: 'restrict' }),
  cancellationReason: text('cancellation_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('schedule_change_request_doctor_status_idx').on(table.doctorId, table.status),
  index('schedule_change_request_expiry_idx').on(table.status, table.expiresAt),
]);

export const scheduleChangeAppointment = pgTable('schedule_change_appointment', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull().references(() => scheduleChangeRequest.id, { onDelete: 'cascade' }),
  appointmentId: text('appointment_id').notNull().references(() => appointment.id, { onDelete: 'cascade' }),
  originalStartsAt: timestamp('original_starts_at', { withTimezone: true }).notNull(),
  originalEndsAt: timestamp('original_ends_at', { withTimezone: true }).notNull(),
  consentStatus: scheduleChangeConsentStatus('consent_status').notNull().default('pending'),
  resolutionStatus: scheduleChangeResolutionStatus('resolution_status').notNull().default('pending'),
  selectedAlternativeId: text('selected_alternative_id'),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  responseReason: text('response_reason'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('schedule_change_appointment_request_unique').on(table.requestId, table.appointmentId),
  index('schedule_change_appointment_request_consent_idx').on(table.requestId, table.consentStatus),
  index('schedule_change_appointment_appointment_idx').on(table.appointmentId),
  check('schedule_change_appointment_time_order_check', sql`${table.originalEndsAt} > ${table.originalStartsAt}`),
]);

export const scheduleChangeAlternative = pgTable('schedule_change_alternative', {
  id: text('id').primaryKey(),
  affectedAppointmentId: text('affected_appointment_id')
    .notNull()
    .references(() => scheduleChangeAppointment.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  rank: integer('rank').notNull(),
  selectedAt: timestamp('selected_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('schedule_change_alternative_slot_unique').on(
    table.affectedAppointmentId, table.startsAt, table.endsAt,
  ),
  index('schedule_change_alternative_affected_rank_idx').on(table.affectedAppointmentId, table.rank),
  check('schedule_change_alternative_time_order_check', sql`${table.endsAt} > ${table.startsAt}`),
  check('schedule_change_alternative_rank_check', sql`${table.rank} > 0`),
]);

export const appointmentHistory = pgTable('appointment_history', {
  id: text('id').primaryKey(),
  appointmentId: text('appointment_id').notNull().references(() => appointment.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  action: text('action').notNull(),
  previousStartsAt: timestamp('previous_starts_at', { withTimezone: true }),
  previousEndsAt: timestamp('previous_ends_at', { withTimezone: true }),
  newStartsAt: timestamp('new_starts_at', { withTimezone: true }),
  newEndsAt: timestamp('new_ends_at', { withTimezone: true }),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('appointment_history_appointment_idx').on(table.appointmentId, table.createdAt),
]);

export const schema = {
  user,
  session,
  account,
  verification,
  doctorProfile,
  appointment,
  patientProfile,
  doctorAvailability,
  doctorLeave,
  doctorScheduleOverride,
  payment,
  refund,
  emailOutbox,
  appointmentReminder,
  scheduleChangeRequest,
  scheduleChangeAppointment,
  scheduleChangeAlternative,
  appointmentHistory,
};
