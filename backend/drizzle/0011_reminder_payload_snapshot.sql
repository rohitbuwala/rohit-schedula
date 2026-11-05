ALTER TABLE "appointment_reminder" ADD COLUMN "recipient_email" text;--> statement-breakpoint
ALTER TABLE "appointment_reminder" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "appointment_reminder" ADD COLUMN "other_party_name" text;--> statement-breakpoint
UPDATE "appointment_reminder" AS reminder
SET
	"recipient_email" = recipient."email",
	"recipient_name" = recipient."name",
	"other_party_name" = CASE
		WHEN reminder."recipient_id" = appt."patient_id" THEN 'Dr. ' || doctor."name"
		ELSE patient."name"
	END
FROM "appointment" AS appt,
	"user" AS recipient,
	"user" AS patient,
	"user" AS doctor
WHERE reminder."appointment_id" = appt."id"
	AND reminder."recipient_id" = recipient."id"
	AND appt."patient_id" = patient."id"
	AND appt."doctor_id" = doctor."id";--> statement-breakpoint
ALTER TABLE "appointment_reminder" ALTER COLUMN "recipient_email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_reminder" ALTER COLUMN "recipient_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_reminder" ALTER COLUMN "other_party_name" SET NOT NULL;
