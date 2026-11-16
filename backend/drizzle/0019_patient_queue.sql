CREATE TYPE "public"."attendance_status" AS ENUM('waiting', 'in_service', 'completed', 'no_show', 'cancelled');--> statement-breakpoint
CREATE TABLE "appointment_attendance" (
	"appointment_id" text PRIMARY KEY NOT NULL,
	"queue_id" text NOT NULL,
	"doctor_id" text NOT NULL,
	"appointment_starts_at" timestamp with time zone NOT NULL,
	"status" "attendance_status" NOT NULL,
	"token_number" integer,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" text,
	"started_at" timestamp with time zone,
	"started_by" text,
	"terminal_at" timestamp with time zone,
	"terminal_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_attendance_version_check" CHECK ("appointment_attendance"."version" > 0),
	CONSTRAINT "appointment_attendance_check_in_check" CHECK (("appointment_attendance"."token_number" is null and "appointment_attendance"."checked_in_at" is null and "appointment_attendance"."checked_in_by" is null) or ("appointment_attendance"."token_number" is not null and "appointment_attendance"."token_number" > 0 and "appointment_attendance"."checked_in_at" is not null and "appointment_attendance"."checked_in_by" is not null)),
	CONSTRAINT "appointment_attendance_actor_pairs_check" CHECK (("appointment_attendance"."started_at" is null) = ("appointment_attendance"."started_by" is null) and ("appointment_attendance"."terminal_at" is null) = ("appointment_attendance"."terminal_by" is null)),
	CONSTRAINT "appointment_attendance_state_check" CHECK (
    ("appointment_attendance"."status" = 'waiting' and "appointment_attendance"."checked_in_at" is not null and "appointment_attendance"."started_at" is null and "appointment_attendance"."terminal_at" is null) or
    ("appointment_attendance"."status" = 'in_service' and "appointment_attendance"."checked_in_at" is not null and "appointment_attendance"."started_at" is not null and "appointment_attendance"."terminal_at" is null) or
    ("appointment_attendance"."status" = 'completed' and "appointment_attendance"."checked_in_at" is not null and "appointment_attendance"."started_at" is not null and "appointment_attendance"."terminal_at" is not null) or
    ("appointment_attendance"."status" = 'no_show' and "appointment_attendance"."checked_in_at" is null and "appointment_attendance"."started_at" is null and "appointment_attendance"."terminal_at" is not null) or
    ("appointment_attendance"."status" = 'cancelled' and "appointment_attendance"."terminal_at" is not null)),
	CONSTRAINT "appointment_attendance_time_check" CHECK (("appointment_attendance"."started_at" is null or ("appointment_attendance"."checked_in_at" is not null and "appointment_attendance"."started_at" >= "appointment_attendance"."checked_in_at")) and ("appointment_attendance"."terminal_at" is null or "appointment_attendance"."terminal_at" >= coalesce("appointment_attendance"."started_at", "appointment_attendance"."checked_in_at", "appointment_attendance"."terminal_at")))
);
--> statement-breakpoint
CREATE TABLE "doctor_daily_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"doctor_id" text NOT NULL,
	"service_date" date NOT NULL,
	"timezone" text NOT NULL,
	"next_token_number" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_daily_queue_counter_check" CHECK ("doctor_daily_queue"."next_token_number" > 0 and "doctor_daily_queue"."version" >= 0)
);
--> statement-breakpoint
-- PostgreSQL requires the referenced composite uniqueness before adding its FK.
CREATE UNIQUE INDEX "doctor_daily_queue_id_doctor_unique" ON "doctor_daily_queue" USING btree ("id","doctor_id");--> statement-breakpoint
ALTER TABLE "appointment_attendance" ADD CONSTRAINT "appointment_attendance_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_attendance" ADD CONSTRAINT "appointment_attendance_checked_in_by_user_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_attendance" ADD CONSTRAINT "appointment_attendance_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_attendance" ADD CONSTRAINT "appointment_attendance_terminal_by_user_id_fk" FOREIGN KEY ("terminal_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_attendance" ADD CONSTRAINT "appointment_attendance_queue_doctor_fk" FOREIGN KEY ("queue_id","doctor_id") REFERENCES "public"."doctor_daily_queue"("id","doctor_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_daily_queue" ADD CONSTRAINT "doctor_daily_queue_doctor_id_user_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_attendance_queue_token_unique" ON "appointment_attendance" USING btree ("queue_id","token_number") WHERE "appointment_attendance"."token_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_attendance_one_current_doctor_unique" ON "appointment_attendance" USING btree ("doctor_id") WHERE "appointment_attendance"."status" = 'in_service';--> statement-breakpoint
CREATE INDEX "appointment_attendance_waiting_idx" ON "appointment_attendance" USING btree ("queue_id","appointment_starts_at","checked_in_at","appointment_id") WHERE "appointment_attendance"."status" = 'waiting';--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_daily_queue_doctor_date_unique" ON "doctor_daily_queue" USING btree ("doctor_id","service_date");
