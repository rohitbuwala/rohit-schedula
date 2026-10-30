CREATE TYPE "public"."user_role" AS ENUM('patient', 'doctor');--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'patient'::"public"."user_role";--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "role" SET DATA TYPE "public"."user_role" USING "role"::"public"."user_role";