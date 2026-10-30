import { z } from "zod";

const secureImageUrlSchema = z.string().url("Enter a valid image URL.").refine((value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, "Image URLs must use HTTPS.");

const phoneSchema = z.string().trim().regex(/^\+?[0-9]{7,15}$/, "Enter a valid phone number (7–15 digits).");

const dateOfBirthSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format.").refine((val) => {
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return false;
  return d <= new Date();
}, "Date of birth cannot be in the future.");

export const bloodGroups = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;
export const genders = ["male", "female", "other", "prefer_not_to_say"] as const;

export const patientProfileFormSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  image: z.union([secureImageUrlSchema, z.literal("")]).optional().nullable(),
  dateOfBirth: z.union([dateOfBirthSchema, z.literal("")]).optional().nullable(),
  gender: z.union([z.enum(genders), z.literal("")]).optional().nullable(),
  phone: z.union([phoneSchema, z.literal("")]).optional().nullable(),
  bloodGroup: z.union([z.enum(bloodGroups), z.literal("")]).optional().nullable(),
  address: z.string().trim().max(500, "Address cannot exceed 500 characters.").optional().nullable(),
  allergies: z.string().trim().max(500, "Allergies note cannot exceed 500 characters.").optional().nullable(),
}).strict();

export type PatientProfileFormData = z.infer<typeof patientProfileFormSchema>;
