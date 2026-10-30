import { boolean, check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRole = pgEnum('user_role', ['patient', 'doctor', 'admin']);
export const doctorProfileStatus = pgEnum('doctor_profile_status', ['pending', 'approved', 'rejected']);
export const appointmentStatus = pgEnum('appointment_status', ['scheduled', 'cancelled', 'completed']);
export type AppointmentStatus = typeof appointmentStatus.enumValues[number];

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('appointment_patient_start_idx').on(table.patientId, table.startsAt),
  index('appointment_doctor_start_idx').on(table.doctorId, table.startsAt),
  check('appointment_distinct_participants_check', sql`${table.patientId} <> ${table.doctorId}`),
  check('appointment_time_order_check', sql`${table.endsAt} > ${table.startsAt}`),
]);

export const schema = { user, session, account, verification, doctorProfile, appointment };
