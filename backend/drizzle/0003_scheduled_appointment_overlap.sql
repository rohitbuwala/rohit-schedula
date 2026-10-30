CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
DO $$
DECLARE
  overlap_count bigint;
BEGIN
  SELECT count(*) INTO overlap_count
  FROM "appointment" AS a
  JOIN "appointment" AS b
    ON a."doctor_id" = b."doctor_id"
   AND a."id" < b."id"
   AND a."status" = 'scheduled'
   AND b."status" = 'scheduled'
   AND tstzrange(a."starts_at", a."ends_at", '[)')
       && tstzrange(b."starts_at", b."ends_at", '[)');

  IF overlap_count > 0 THEN
    RAISE EXCEPTION 'Cannot add scheduled appointment overlap constraint: % overlapping appointment pair(s) exist. Resolve them manually and rerun migration 0003.', overlap_count;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_doctor_scheduled_no_overlap"
  EXCLUDE USING gist (
    "doctor_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" = 'scheduled');
