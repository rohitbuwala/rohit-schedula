import { z } from 'zod';

// Phone: optional, 7-15 digits (E.164-style loose validation)
const phoneSchema = z.string().trim().regex(/^\+?[0-9]{7,15}$/, 'Enter a valid phone number (7–15 digits).').optional().transform((value) => value || null);

export const doctorApplicationSchema = z.object({
  specialty: z.string().trim().min(2).max(100),
  licenseRegion: z.string().trim().min(2).max(80),
  licenseNumber: z.string().trim().min(3).max(80),
  bio: z.string().trim().max(1000).optional().transform((value) => value || null),
  // Extended profile fields
  phone: phoneSchema,
  qualifications: z.string().trim().max(500).optional().transform((value) => value || null),
  yearsOfExperience: z.number().int().min(0).max(70).nullable().optional().transform((value) => value ?? null),
  consultationFeeInr: z.number().int().min(0).nullable().optional().transform((value) => value ?? null),
  clinicName: z.string().trim().max(200).optional().transform((value) => value || null),
  clinicAddress: z.string().trim().max(500).optional().transform((value) => value || null),
  profilePhotoUrl: z.url().max(2000).optional().nullable().transform((value) => value || null),
}).strict();

export const doctorDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approved'),
    reason: z.string().trim().max(500).optional(),
  }).strict(),
  z.object({
    decision: z.literal('rejected'),
    reason: z.string().trim().min(5, 'A rejection reason of at least 5 characters is required.').max(500),
  }).strict(),
]);

export const doctorApplicationStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export const doctorAdminListQuerySchema = z.enum(['pending', 'approved', 'rejected', 'all']);

export const doctorProfileUpdateSchema = z.object({
  bio: z.string().trim().max(1000).nullable().optional(),
  phone: phoneSchema,
  qualifications: z.string().trim().max(500).nullable().optional(),
  yearsOfExperience: z.number().int().min(0).max(70).nullable().optional(),
  consultationFeeInr: z.number().int().min(0).nullable().optional(),
  clinicName: z.string().trim().max(200).nullable().optional(),
  clinicAddress: z.string().trim().max(500).nullable().optional(),
  profilePhotoUrl: z.url().max(2000).nullable().optional(),
}).strict().superRefine((data, ctx) => {
  const hasValue = Object.entries(data).some(([key, val]) => {
    if (key === 'phone') return val !== null;
    return val !== undefined;
  });
  if (!hasValue) {
    ctx.addIssue({
      code: 'custom',
      message: 'At least one field must be provided for update.',
    });
  }
});

export type DoctorApplicationInput = z.infer<typeof doctorApplicationSchema>;
export type DoctorDecisionInput = z.infer<typeof doctorDecisionSchema>;
export type DoctorProfileUpdateInput = z.infer<typeof doctorProfileUpdateSchema>;

export interface PublicDoctorProfileInput {
  id: string;
  name: string;
  specialty: string;
  bio: string | null;
  qualifications: string | null;
  yearsOfExperience: number | null;
  consultationFeeInr: number | null;
  clinicName: string | null;
  clinicAddress: string | null;
  profilePhotoUrl: string | null;
}

export function toPublicDoctorProfile(profile: PublicDoctorProfileInput) {
  return {
    id: profile.id,
    name: profile.name,
    specialty: profile.specialty,
    bio: profile.bio,
    qualifications: profile.qualifications,
    yearsOfExperience: profile.yearsOfExperience,
    consultationFeeInr: profile.consultationFeeInr,
    clinicName: profile.clinicName,
    clinicAddress: profile.clinicAddress,
    profilePhotoUrl: profile.profilePhotoUrl,
    isVerified: true,
  };
}
