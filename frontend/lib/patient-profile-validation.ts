import { z } from "zod";

const secureImageUrlSchema = z.string().url("Enter a valid image URL.").refine((value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, "Image URLs must use HTTPS.");

export const patientProfileFormSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  image: z.union([secureImageUrlSchema, z.literal("")]).optional(),
}).strict();
