import { z } from 'zod';

const secureImageUrlSchema = z.url().refine((value) => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}, 'Image URL must use HTTPS.');

export const patientProfileUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  image: secureImageUrlSchema.nullable().optional(),
}).strict().refine((value) => value.name !== undefined || value.image !== undefined, {
  message: 'Provide at least one profile field to update.',
});

export type PatientProfileUpdate = z.infer<typeof patientProfileUpdateSchema>;
