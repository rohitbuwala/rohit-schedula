CREATE TABLE "appointment_booking_token" (
	"appointment_id" text PRIMARY KEY NOT NULL,
	"queue_id" text NOT NULL,
	"doctor_id" text NOT NULL,
	"appointment_starts_at" timestamp with time zone NOT NULL,
	"token_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_booking_token_positive" CHECK ("appointment_booking_token"."token_number" > 0)
);
--> statement-breakpoint
DROP INDEX "appointment_attendance_waiting_idx";--> statement-breakpoint
ALTER TABLE "appointment_booking_token" ADD CONSTRAINT "appointment_booking_token_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_token" ADD CONSTRAINT "appointment_booking_token_queue_doctor_fk" FOREIGN KEY ("queue_id","doctor_id") REFERENCES "public"."doctor_daily_queue"("id","doctor_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_booking_token_queue_number_unique" ON "appointment_booking_token" USING btree ("queue_id","token_number");--> statement-breakpoint
CREATE INDEX "appointment_attendance_waiting_idx" ON "appointment_attendance" USING btree ("queue_id","checked_in_at","appointment_id") WHERE "appointment_attendance"."status" = 'waiting';
--> statement-breakpoint
-- Backfill runs inside the migration transaction. Block concurrent booking and
-- check-in writes while copying issued tokens and advancing shared counters.
LOCK TABLE appointment, appointment_attendance, doctor_daily_queue IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO appointment_booking_token (appointment_id, queue_id, doctor_id, appointment_starts_at, token_number, created_at)
SELECT appointment_id, queue_id, doctor_id, appointment_starts_at, token_number, created_at
FROM appointment_attendance WHERE token_number IS NOT NULL;
--> statement-breakpoint
INSERT INTO doctor_daily_queue (id, doctor_id, service_date, timezone)
SELECT gen_random_uuid()::text, candidates.doctor_id, candidates.service_date, candidates.timezone
FROM (
  SELECT DISTINCT a.doctor_id, (a.starts_at AT TIME ZONE coalesce(d.timezone, 'Asia/Kolkata'))::date AS service_date,
    coalesce(d.timezone, 'Asia/Kolkata') AS timezone
  FROM appointment a LEFT JOIN doctor_availability d ON d.doctor_id = a.doctor_id
  WHERE a.status = 'scheduled' OR (a.status = 'pending_payment' AND a.hold_expires_at > now())
) candidates
ON CONFLICT (doctor_id, service_date) DO NOTHING;
--> statement-breakpoint
UPDATE doctor_daily_queue q SET next_token_number = greatest(q.next_token_number, issued.highest + 1)
FROM (SELECT queue_id, max(token_number) AS highest FROM appointment_booking_token GROUP BY queue_id) issued
WHERE issued.queue_id = q.id;
--> statement-breakpoint
-- Existing tokens keep their numbers. Unarrived bookings receive unused numbers
-- after them in booking creation order. No check-in or position is fabricated.
WITH missing AS (
  SELECT a.id AS appointment_id, q.id AS queue_id, a.doctor_id, a.starts_at,
    q.next_token_number + row_number() OVER (PARTITION BY q.id ORDER BY a.created_at, a.id) - 1 AS token_number,
    a.created_at
  FROM appointment a
  LEFT JOIN doctor_availability d ON d.doctor_id = a.doctor_id
  JOIN doctor_daily_queue q ON q.doctor_id = a.doctor_id
    AND q.service_date = (a.starts_at AT TIME ZONE coalesce(d.timezone, 'Asia/Kolkata'))::date
  LEFT JOIN appointment_booking_token t ON t.appointment_id = a.id
  WHERE t.appointment_id IS NULL AND (a.status = 'scheduled' OR (a.status = 'pending_payment' AND a.hold_expires_at > now()))
)
INSERT INTO appointment_booking_token (appointment_id, queue_id, doctor_id, appointment_starts_at, token_number, created_at)
SELECT appointment_id, queue_id, doctor_id, starts_at, token_number::integer, created_at FROM missing;
--> statement-breakpoint
UPDATE doctor_daily_queue q SET next_token_number = greatest(q.next_token_number, issued.highest + 1), version = q.version + 1
FROM (SELECT queue_id, max(token_number) AS highest FROM appointment_booking_token GROUP BY queue_id) issued
WHERE issued.queue_id = q.id;
