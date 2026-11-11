CREATE TYPE "public"."schedule_change_consent_status" AS ENUM('pending', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."schedule_change_request_status" AS ENUM('pending', 'published', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."schedule_change_resolution_status" AS ENUM('pending', 'rescheduled', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "schedule_change_alternative" (
	"id" text PRIMARY KEY NOT NULL,
	"affected_appointment_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"rank" integer NOT NULL,
	"selected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_change_alternative_time_order_check" CHECK ("schedule_change_alternative"."ends_at" > "schedule_change_alternative"."starts_at"),
	CONSTRAINT "schedule_change_alternative_rank_check" CHECK ("schedule_change_alternative"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE "schedule_change_appointment" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"original_starts_at" timestamp with time zone NOT NULL,
	"original_ends_at" timestamp with time zone NOT NULL,
	"consent_status" "schedule_change_consent_status" DEFAULT 'pending' NOT NULL,
	"resolution_status" "schedule_change_resolution_status" DEFAULT 'pending' NOT NULL,
	"selected_alternative_id" text,
	"responded_at" timestamp with time zone,
	"response_reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_change_appointment_time_order_check" CHECK ("schedule_change_appointment"."original_ends_at" > "schedule_change_appointment"."original_starts_at")
);
--> statement-breakpoint
CREATE TABLE "schedule_change_request" (
	"id" text PRIMARY KEY NOT NULL,
	"doctor_id" text NOT NULL,
	"proposed_schedule" jsonb NOT NULL,
	"status" "schedule_change_request_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"published_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_change_alternative" ADD CONSTRAINT "schedule_change_alternative_affected_appointment_id_schedule_change_appointment_id_fk" FOREIGN KEY ("affected_appointment_id") REFERENCES "public"."schedule_change_appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_appointment" ADD CONSTRAINT "schedule_change_appointment_request_id_schedule_change_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."schedule_change_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_appointment" ADD CONSTRAINT "schedule_change_appointment_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_request" ADD CONSTRAINT "schedule_change_request_doctor_id_user_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_request" ADD CONSTRAINT "schedule_change_request_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_request" ADD CONSTRAINT "schedule_change_request_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_change_alternative_slot_unique" ON "schedule_change_alternative" USING btree ("affected_appointment_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "schedule_change_alternative_affected_rank_idx" ON "schedule_change_alternative" USING btree ("affected_appointment_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_change_appointment_request_unique" ON "schedule_change_appointment" USING btree ("request_id","appointment_id");--> statement-breakpoint
CREATE INDEX "schedule_change_appointment_request_consent_idx" ON "schedule_change_appointment" USING btree ("request_id","consent_status");--> statement-breakpoint
CREATE INDEX "schedule_change_appointment_appointment_idx" ON "schedule_change_appointment" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "schedule_change_request_doctor_status_idx" ON "schedule_change_request" USING btree ("doctor_id","status");--> statement-breakpoint
CREATE INDEX "schedule_change_request_expiry_idx" ON "schedule_change_request" USING btree ("status","expires_at");