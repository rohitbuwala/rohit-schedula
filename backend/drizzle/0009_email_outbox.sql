CREATE TABLE "email_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"recipient" text NOT NULL,
	"payload" jsonb NOT NULL,
	"appointment_id" text,
	"payment_id" text,
	"refund_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"last_error" text,
	"processing_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_event_type_check" CHECK ("email_outbox"."event_type" in ('booking_confirmation', 'payment_receipt', 'appointment_cancelled', 'appointment_rescheduled', 'refund_processed')),
	CONSTRAINT "email_outbox_status_check" CHECK ("email_outbox"."status" in ('pending', 'processing', 'sent', 'dead')),
	CONSTRAINT "email_outbox_attempt_count_check" CHECK ("email_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_event_key_unique" ON "email_outbox" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "email_outbox_pending_idx" ON "email_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "email_outbox_lease_idx" ON "email_outbox" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "email_outbox_retention_idx" ON "email_outbox" USING btree ("status","sent_at","updated_at");