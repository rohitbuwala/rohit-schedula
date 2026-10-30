ALTER TABLE "doctor_profile" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "qualifications" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "years_of_experience" integer;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "consultation_fee_inr" integer;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "clinic_name" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "clinic_address" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "profile_photo_url" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_fee_non_negative_check" CHECK ("doctor_profile"."consultation_fee_inr" is null or "doctor_profile"."consultation_fee_inr" >= 0);--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_experience_non_negative_check" CHECK ("doctor_profile"."years_of_experience" is null or "doctor_profile"."years_of_experience" >= 0);
