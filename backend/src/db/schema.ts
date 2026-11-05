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

export const schema = {
  user,
  session,
  account,
  verification,
  doctorProfile,
  appointment,
  patientProfile,
  payment,
  refund,
  emailOutbox,
  appointmentReminder,
};
