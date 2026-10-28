import { z } from 'zod';

export const doctorApplicationSchema = z.object({
  specialty: z.string().trim().min(2).max(100),
  licenseRegion: z.string().trim().min(2).max(80),
  licenseNumber: z.string().trim().min(3).max(80),
  bio: z.string().trim().max(1000).optional().transform((value) => value || null),
}).strict();

export const doctorDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
}).strict();

export const doctorApplicationStatusSchema = z.enum(['pending', 'approved', 'rejected']);

export type DoctorApplicationInput = z.infer<typeof doctorApplicationSchema>;

export interface PublicDoctorProfileInput {
  id: string;
  name: string;
  specialty: string;
  bio: string | null;
}

export function toPublicDoctorProfile(profile: PublicDoctorProfileInput) {
  return { id: profile.id, name: profile.name, specialty: profile.specialty, bio: profile.bio };
}
