-- Custom SQL migration: 0007_razorpay_payments.sql
-- Prepared for Razorpay Payment System integration and active hold conflict prevention.

-- 1. Create payment_status enum
DO $$ BEGIN
  CREATE TYPE "public"."payment_status" AS ENUM('created', 'captured', 'failed', 'refunded');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- 2. Add pending_payment to appointment_status enum
ALTER TYPE "public"."appointment_status" ADD VALUE IF NOT EXISTS 'pending_payment';
--> statement-breakpoint

-- 3. Add hold_expires_at column to appointment
ALTER TABLE "appointment" ADD COLUMN IF NOT EXISTS "hold_expires_at" timestamp with time zone;
--> statement-breakpoint

-- 4. Create payment table
CREATE TABLE IF NOT EXISTS "payment" (
	"id" text PRIMARY KEY NOT NULL,
	"appointment_id" text NOT NULL REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action,
	"patient_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action,
	"doctor_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action,
	"razorpay_order_id" text NOT NULL,
	"razorpay_payment_id" text,
	"razorpay_signature" text,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "payment_status" DEFAULT 'created' NOT NULL,
	"receipt" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_razorpay_order_id_unique" UNIQUE("razorpay_order_id"),
	CONSTRAINT "payment_razorpay_payment_id_unique" UNIQUE("razorpay_payment_id"),
	CONSTRAINT "payment_amount_positive_check" CHECK ("amount_paise" > 0)
);
--> statement-breakpoint

-- 5. Indexes for payment and appointment
CREATE INDEX IF NOT EXISTS "payment_appointment_idx" ON "payment" USING btree ("appointment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_patient_idx" ON "payment" USING btree ("patient_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_doctor_idx" ON "payment" USING btree ("doctor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_status_idx" ON "payment" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_order_idx" ON "payment" USING btree ("razorpay_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_status_hold_idx" ON "appointment" USING btree ("status", "hold_expires_at");
--> statement-breakpoint

-- 6. Update PostgreSQL exclusion constraint to prevent overlapping scheduled AND pending_payment appointments
-- Note: Uses immutable predicate (status = 'scheduled' OR status = 'pending_payment') without volatile now()
ALTER TABLE "appointment" DROP CONSTRAINT IF EXISTS "appointment_doctor_scheduled_no_overlap";
--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_doctor_scheduled_no_overlap"
  EXCLUDE USING gist (
    "doctor_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" = 'scheduled' OR "status" = 'pending_payment');
