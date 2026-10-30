import { z } from "zod";

export const doctorApplicationFormSchema = z.object({
  specialty: z.string().trim().min(2, "Enter a specialty (at least 2 characters).").max(100, "Specialty must be 100 characters or fewer."),
  licenseRegion: z.string().trim().min(2, "Enter a license region (at least 2 characters).").max(80, "License region must be 80 characters or fewer."),
  licenseNumber: z.string().trim().min(3, "Enter a license number (at least 3 characters).").max(80, "License number must be 80 characters or fewer."),
  bio: z.string().trim().max(1000, "Bio must be 1000 characters or fewer."),
  // Extended profile fields
  phone: z.string().trim().regex(/^\+?[0-9]{7,15}$/, "Enter a valid phone number (7–15 digits).").or(z.literal("")).transform((v) => v || null).optional(),
  qualifications: z.string().trim().max(500, "Qualifications must be 500 characters or fewer.").optional(),
  yearsOfExperience: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int("Enter a whole number of years.").min(0, "Years of experience must be 0 or more.").max(70, "Years of experience must be 70 or fewer.").nullable()
  ),
  consultationFeeInr: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int("Enter a whole number for the fee.").min(0, "Consultation fee must be 0 or more.").nullable()
  ),
  clinicName: z.string().trim().max(200, "Clinic name must be 200 characters or fewer.").optional(),
  clinicAddress: z.string().trim().max(500, "Clinic address must be 500 characters or fewer.").optional(),
  profilePhotoUrl: z.url("Enter a valid URL for the profile photo.").max(2000, "URL is too long.").or(z.literal("")).transform((v) => v || null).optional(),
}).strict();

export type DoctorApplicationFormValues = z.infer<typeof doctorApplicationFormSchema>;
