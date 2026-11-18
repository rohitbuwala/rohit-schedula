import { z } from 'zod';

// Better Auth user IDs are opaque strings, not necessarily UUIDs.
export const staffUserIdSchema = z.string().trim().min(1).max(128);
export const staffCandidateSchema = z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()) }).strict();
export const createStaffSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(8).max(128),
}).strict();
export const provisionStaffSchema = z.object({
  userId: staffUserIdSchema,
  confirmed: z.literal(true),
}).strict();
export const assignStaffSchema = z.object({ doctorId: staffUserIdSchema }).strict();
export const listStaffSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
