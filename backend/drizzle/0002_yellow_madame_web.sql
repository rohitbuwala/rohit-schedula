CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."doctor_profile_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'admin';--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"doctor_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_distinct_participants_check" CHECK ("appointment"."patient_id" <> "appointment"."doctor_id"),
	CONSTRAINT "appointment_time_order_check" CHECK ("appointment"."ends_at" > "appointment"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "doctor_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"specialty" text NOT NULL,
	"license_region" text NOT NULL,
	"license_number" text NOT NULL,
	"bio" text,
	"status" "doctor_profile_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	CONSTRAINT "doctor_profile_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "doctor_profile_review_state_check" CHECK (("doctor_profile"."status" = 'pending' and "doctor_profile"."reviewed_at" is null and "doctor_profile"."reviewed_by" is null) or ("doctor_profile"."status" <> 'pending' and "doctor_profile"."reviewed_at" is not null and "doctor_profile"."reviewed_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_user_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_doctor_id_user_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_patient_start_idx" ON "appointment" USING btree ("patient_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_doctor_start_idx" ON "appointment" USING btree ("doctor_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profile_license_unique" ON "doctor_profile" USING btree ("license_region","license_number");--> statement-breakpoint
CREATE INDEX "doctor_profile_status_submitted_idx" ON "doctor_profile" USING btree ("status","submitted_at");