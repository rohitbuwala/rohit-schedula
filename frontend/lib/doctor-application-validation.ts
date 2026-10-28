import { z } from "zod";

export const doctorApplicationFormSchema = z.object({
  specialty: z.string().trim().min(2, "Enter a specialty (at least 2 characters).").max(100, "Specialty must be 100 characters or fewer."),
  licenseRegion: z.string().trim().min(2, "Enter a license region (at least 2 characters).").max(80, "License region must be 80 characters or fewer."),
  licenseNumber: z.string().trim().min(3, "Enter a license number (at least 3 characters).").max(80, "License number must be 80 characters or fewer."),
  bio: z.string().trim().max(1000, "Bio must be 1000 characters or fewer."),
}).strict();
