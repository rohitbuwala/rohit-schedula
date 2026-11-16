ALTER TYPE "public"."user_role" ADD VALUE 'staff';--> statement-breakpoint
-- appointment_history already exists from 0005; older snapshots omitted it.
-- Keep this migration limited to the new staff role and assignment table.
CREATE TABLE "staff_doctor_assignment" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_id" text NOT NULL,
	"doctor_id" text NOT NULL,
	"assigned_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "staff_doctor_assignment_distinct_check" CHECK ("staff_doctor_assignment"."staff_id" <> "staff_doctor_assignment"."doctor_id"),
	CONSTRAINT "staff_doctor_assignment_time_check" CHECK ("staff_doctor_assignment"."revoked_at" is null or "staff_doctor_assignment"."revoked_at" >= "staff_doctor_assignment"."created_at")
);
--> statement-breakpoint
ALTER TABLE "staff_doctor_assignment" ADD CONSTRAINT "staff_doctor_assignment_staff_id_user_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_doctor_assignment" ADD CONSTRAINT "staff_doctor_assignment_doctor_id_user_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_doctor_assignment" ADD CONSTRAINT "staff_doctor_assignment_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_doctor_assignment_pair_unique" ON "staff_doctor_assignment" USING btree ("staff_id","doctor_id");--> statement-breakpoint
CREATE INDEX "staff_doctor_assignment_active_idx" ON "staff_doctor_assignment" USING btree ("staff_id","doctor_id") WHERE "staff_doctor_assignment"."revoked_at" is null;
