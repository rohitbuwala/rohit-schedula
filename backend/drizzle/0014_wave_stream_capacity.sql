ALTER TABLE "doctor_availability"
  ADD COLUMN "scheduling_mode" text NOT NULL DEFAULT 'stream',
  ADD COLUMN "capacity" integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT "doctor_availability_scheduling_mode_check"
    CHECK ("scheduling_mode" IN ('wave', 'stream')),
  ADD CONSTRAINT "doctor_availability_capacity_check"
    CHECK ("capacity" > 0);--> statement-breakpoint

ALTER TABLE "doctor_schedule_override"
  ADD COLUMN "scheduling_mode" text,
  ADD COLUMN "capacity" integer,
  ADD CONSTRAINT "doctor_schedule_override_mode_check"
    CHECK ("scheduling_mode" IS NULL OR "scheduling_mode" IN ('wave', 'stream')),
  ADD CONSTRAINT "doctor_schedule_override_capacity_check"
    CHECK ("capacity" IS NULL OR "capacity" > 0);--> statement-breakpoint

-- Capacity is enforced while holding the doctor's availability row lock in the
-- same transaction as the appointment hold insert. The old exclusion constraint
-- imposed a hard capacity of one and must be removed for configured capacities.
ALTER TABLE "appointment" DROP CONSTRAINT IF EXISTS "appointment_doctor_scheduled_no_overlap";
