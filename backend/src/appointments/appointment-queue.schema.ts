import { z } from 'zod';
import { staffUserIdSchema } from '../auth/staff-access.schema.js';

export const queueAppointmentIdSchema = z.uuid();
export const queueCheckInBodySchema = z.object({}).strict();
export const queueReadSchema = z.object({
  doctorId: staffUserIdSchema,
  date: z.iso.date(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().regex(/^\d{1,10}:\d{1,6}$/).refine(value => {
    const [version, offset] = value.split(':').map(Number);
    return version <= 2147483647 && offset <= 100000;
  }).optional(),
}).strict();
export const ownQueueReadSchema = z.object({
  appointmentIds: z.string().transform(value => value.split(',')).pipe(z.array(z.uuid()).min(1).max(50))
    .refine(ids => new Set(ids).size === ids.length, 'Appointment identifiers must be unique.'),
}).strict();
export type QueueReadInput = z.infer<typeof queueReadSchema>;
export const queueNextSchema = z.object({
  serviceDate: z.iso.date(),
  expectedQueueVersion: z.number().int().min(0).max(2147483647),
}).strict();
export const queueNoShowSchema = z.object({
  expectedAttendanceVersion: z.number().int().min(0).max(2147483647).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();
export type QueueNextInput = z.infer<typeof queueNextSchema>;
export type QueueNoShowInput = z.infer<typeof queueNoShowSchema>;
