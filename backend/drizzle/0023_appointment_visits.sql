CREATE TABLE "appointment_visit" (
	"appointment_id" text PRIMARY KEY NOT NULL,
	"notes" text NOT NULL,
	"details" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_visit_revision_check" CHECK ("appointment_visit"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "appointment_visit" ADD CONSTRAINT "appointment_visit_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE restrict ON UPDATE no action;