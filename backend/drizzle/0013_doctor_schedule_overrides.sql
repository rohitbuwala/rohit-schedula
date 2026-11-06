CREATE UNIQUE INDEX IF NOT EXISTS "doctor_leave_doctor_date_unique"
  ON "doctor_leave" ("doctor_id", "date");--> statement-breakpoint

CREATE TABLE "doctor_schedule_override" (
  "id" text PRIMARY KEY NOT NULL,
  "doctor_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "start_hour" integer NOT NULL,
  "end_hour" integer NOT NULL,
  "slot_duration_minutes" integer NOT NULL DEFAULT 30,
  "break_start" text,
  "break_end" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "doctor_schedule_override_hour_check" CHECK ("start_hour" >= 0 AND "end_hour" <= 24 AND "end_hour" > "start_hour"),
  CONSTRAINT "doctor_schedule_override_duration_check" CHECK ("slot_duration_minutes" IN (15, 30)),
  CONSTRAINT "doctor_schedule_override_date_check" CHECK ("date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);--> statement-breakpoint

CREATE UNIQUE INDEX "doctor_schedule_override_doctor_date_unique"
  ON "doctor_schedule_override" USING btree ("doctor_id", "date");--> statement-breakpoint
CREATE INDEX "doctor_schedule_override_doctor_date_idx"
  ON "doctor_schedule_override" USING btree ("doctor_id", "date");
