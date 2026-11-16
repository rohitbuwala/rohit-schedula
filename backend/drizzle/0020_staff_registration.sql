CREATE TABLE "staff_registration_request" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	CONSTRAINT "staff_registration_review_check" CHECK (("staff_registration_request"."status" = 'pending' and "staff_registration_request"."reviewed_at" is null and "staff_registration_request"."reviewed_by" is null) or ("staff_registration_request"."status" = 'approved' and "staff_registration_request"."reviewed_at" is not null and "staff_registration_request"."reviewed_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "staff_registration_request" ADD CONSTRAINT "staff_registration_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_registration_request" ADD CONSTRAINT "staff_registration_request_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_registration_pending_idx" ON "staff_registration_request" USING btree ("requested_at") WHERE "staff_registration_request"."status" = 'pending';