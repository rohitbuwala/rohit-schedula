import { z } from "zod";

export const doctorApplicationResponseSchema = z.object({
  id: z.uuid(),
  specialty: z.string(),
  licenseRegion: z.string(),
  licenseNumber: z.string(),
  bio: z.string().nullable(),
  // Extended profile fields (optional so old responses still parse)
  phone: z.string().nullable().optional(),
  qualifications: z.string().nullable().optional(),
  yearsOfExperience: z.number().int().nullable().optional(),
  consultationFeeInr: z.number().int().nullable().optional(),
  clinicName: z.string().nullable().optional(),
  clinicAddress: z.string().nullable().optional(),
  profilePhotoUrl: z.string().nullable().optional(),
  status: z.enum(["pending", "approved", "rejected"]),
  submittedAt: z.string(),
  reviewedAt: z.string().nullable(),
});

export type DoctorApplicationResponse = z.infer<typeof doctorApplicationResponseSchema>;

/** An empty successful /api/doctor-applications/me response represents no application. */
export function parseDoctorApplicationResponseBody(body: string): DoctorApplicationResponse | null {
  if (body.length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Application status returned invalid JSON.");
  }

  if (value === null) return null;
  const parsed = doctorApplicationResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Application status returned an unexpected response.");
  return parsed.data;
}
