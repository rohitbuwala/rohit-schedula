CREATE TABLE "appointment_prescription" (
	"appointment_id" text PRIMARY KEY NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"medications" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_prescription" ADD CONSTRAINT "appointment_prescription_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE restrict ON UPDATE no action;