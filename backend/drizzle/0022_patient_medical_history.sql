CREATE TABLE "patient_medical_history" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"appointment_id" text,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_medical_history_actor_role_check" CHECK ("patient_medical_history"."actor_role" in ('patient', 'doctor'))
);
--> statement-breakpoint
ALTER TABLE "patient_profile" ADD COLUMN "medical_conditions" text;--> statement-breakpoint
ALTER TABLE "patient_profile" ADD COLUMN "medical_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_medical_history" ADD CONSTRAINT "patient_medical_history_patient_id_user_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_medical_history" ADD CONSTRAINT "patient_medical_history_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_medical_history" ADD CONSTRAINT "patient_medical_history_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_medical_history_patient_created_idx" ON "patient_medical_history" USING btree ("patient_id","created_at","id");