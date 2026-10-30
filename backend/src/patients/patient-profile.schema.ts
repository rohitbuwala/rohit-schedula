import { z } from 'zod';

const secureImageUrlSchema = z.string().url('Image URL must be valid.').refine((value) => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}, 'Image URL must use HTTPS.');

const phoneSchema = z.string().trim().regex(/^\+?[0-9]{7,15}$/, 'Enter a valid phone number (7–15 digits).');

const dateOfBirthSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be in YYYY-MM-DD format.').refine((val) => {
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  if (d > now) return false;
  const minDate = new Date(now.getFullYear() - 130, now.getMonth(), now.getDate());
  return d >= minDate;
}, 'Enter a valid date of birth in the past.');

export const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const genders = ['male', 'female', 'other', 'prefer_not_to_say'] as const;

export const patientProfileUpdateSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(100).optional(),
  image: z.union([secureImageUrlSchema, z.literal('')]).transform((v) => v || null).nullable().optional(),
  dateOfBirth: z.union([dateOfBirthSchema, z.literal('')]).transform((v) => v || null).nullable().optional(),
  gender: z.union([z.enum(genders), z.literal('')]).transform((v) => v || null).nullable().optional(),
  phone: z.union([phoneSchema, z.literal('')]).transform((v) => v || null).nullable().optional(),
  bloodGroup: z.union([z.enum(bloodGroups), z.literal('')]).transform((v) => v || null).nullable().optional(),
  address: z.string().trim().max(500, 'Address cannot exceed 500 characters.').transform((v) => v || null).nullable().optional(),
  allergies: z.string().trim().max(500, 'Allergies cannot exceed 500 characters.').transform((v) => v || null).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one profile field to update.',
});

export type PatientProfileUpdate = z.infer<typeof patientProfileUpdateSchema>;
