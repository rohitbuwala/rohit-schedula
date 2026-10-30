-- Custom SQL migration: 0006_patient_profile.sql
-- Prepared for Medrella patient profile details (demographics, contact, essential clinical notes).
-- DO NOT EXECUTE AGAINST PRODUCTION WITHOUT EXPLICIT PERMISSION.

CREATE TABLE IF NOT EXISTS "patient_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"date_of_birth" text,
	"gender" text,
	"phone" text,
	"blood_group" text,
	"address" text,
	"allergies" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_profile_user_id_unique" UNIQUE("user_id")
);

CREATE INDEX IF NOT EXISTS "patient_profile_user_idx" ON "patient_profile" ("user_id");
