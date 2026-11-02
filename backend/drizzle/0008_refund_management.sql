CREATE TYPE "public"."refund_status" AS ENUM('pending', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "refund" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"doctor_id" text NOT NULL,
	"razorpay_payment_id" text NOT NULL,
	"razorpay_refund_id" text,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"arn" text,
	"notes" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_razorpay_refund_id_unique" UNIQUE("razorpay_refund_id"),
	CONSTRAINT "refund_amount_positive_check" CHECK ("refund"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "refunded_amount_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_patient_id_user_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_doctor_id_user_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_payment_idx" ON "refund" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refund_appointment_idx" ON "refund" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "refund_patient_idx" ON "refund" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "refund_doctor_idx" ON "refund" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "refund_status_idx" ON "refund" USING btree ("status");--> statement-breakpoint
CREATE INDEX "refund_razorpay_refund_idx" ON "refund" USING btree ("razorpay_refund_id");--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_refunded_amount_check" CHECK ("payment"."refunded_amount_paise" >= 0 and "payment"."refunded_amount_paise" <= "payment"."amount_paise");