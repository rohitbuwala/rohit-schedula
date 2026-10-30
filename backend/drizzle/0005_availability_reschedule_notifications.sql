-- Custom SQL migration: 0005_availability_reschedule_notifications.sql
-- Prepared for Medrella doctor availability, reschedule audit trail, and persistent in-app notifications.
-- DO NOT EXECUTE AGAINST PRODUCTION WITHOUT EXPLICIT PERMISSION.

-- 1. Create notification table
CREATE TABLE IF NOT EXISTS "notification" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "type" text NOT NULL DEFAULT 'system',
  "read" boolean NOT NULL DEFAULT false,
  "appointment_id" text REFERENCES "appointment"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "notification_user_created_idx" ON "notification" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "notification_user_unread_idx" ON "notification" ("user_id", "read") WHERE "read" = false;

-- 2. Create doctor availability table
CREATE TABLE IF NOT EXISTS "doctor_availability" (
  "id" text PRIMARY KEY NOT NULL,
  "doctor_id" text NOT NULL UNIQUE REFERENCES "user"("id") ON DELETE CASCADE,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "active_days" integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  "start_hour" integer NOT NULL DEFAULT 9,
  "end_hour" integer NOT NULL DEFAULT 17,
  "slot_duration_minutes" integer NOT NULL DEFAULT 30,
  "break_start" text,
  "break_end" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- 3. Create doctor leave table
CREATE TABLE IF NOT EXISTS "doctor_leave" (
  "id" text PRIMARY KEY NOT NULL,
  "doctor_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "doctor_leave_doctor_date_idx" ON "doctor_leave" ("doctor_id", "date");

-- 4. Create appointment history table
CREATE TABLE IF NOT EXISTS "appointment_history" (
  "id" text PRIMARY KEY NOT NULL,
  "appointment_id" text NOT NULL REFERENCES "appointment"("id") ON DELETE CASCADE,
  "actor_id" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "action" text NOT NULL,
  "previous_starts_at" timestamp with time zone,
  "previous_ends_at" timestamp with time zone,
  "new_starts_at" timestamp with time zone,
  "new_ends_at" timestamp with time zone,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "appointment_history_appointment_idx" ON "appointment_history" ("appointment_id", "created_at" DESC);
