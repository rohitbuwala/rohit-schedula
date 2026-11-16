CREATE TABLE "appointment_idempotency" (
	"patient_id" text NOT NULL,
	"key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"appointment_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_idempotency" ADD CONSTRAINT "appointment_idempotency_patient_id_user_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_idempotency" ADD CONSTRAINT "appointment_idempotency_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_idempotency_patient_key_unique" ON "appointment_idempotency" USING btree ("patient_id","key");