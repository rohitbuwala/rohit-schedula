CREATE TABLE "appointment_reminder" (
	"id" text PRIMARY KEY NOT NULL,
	"appointment_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"appointment_starts_at" timestamp with time zone NOT NULL,
	"generation" integer NOT NULL,
	"timezone" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"last_error" text,
	"processing_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_reminder_interval_check" CHECK ("appointment_reminder"."interval_minutes" in (60, 1440)),
	CONSTRAINT "appointment_reminder_status_check" CHECK ("appointment_reminder"."status" in ('pending', 'processing', 'sent', 'cancelled', 'dead')),
	CONSTRAINT "appointment_reminder_attempt_count_check" CHECK ("appointment_reminder"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "reminder_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_reminder" ADD CONSTRAINT "appointment_reminder_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_reminder" ADD CONSTRAINT "appointment_reminder_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_reminder_identity_unique" ON "appointment_reminder" USING btree ("appointment_id","recipient_id","interval_minutes","generation");--> statement-breakpoint
CREATE INDEX "appointment_reminder_due_idx" ON "appointment_reminder" USING btree ("status","next_attempt_at","scheduled_for");--> statement-breakpoint
CREATE INDEX "appointment_reminder_lease_idx" ON "appointment_reminder" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "appointment_reminder_appointment_status_idx" ON "appointment_reminder" USING btree ("appointment_id","status");