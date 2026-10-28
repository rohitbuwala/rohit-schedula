import { z } from "zod";

export const doctorApplicationResponseSchema = z.object({
  id: z.uuid(),
  specialty: z.string(),
  licenseRegion: z.string(),
  licenseNumber: z.string(),
  bio: z.string().nullable(),
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
