import { z } from 'zod';

export const appointmentAvailabilityQuerySchema = z.object({
  doctorProfileId: z.uuid(),
  date: z.iso.date(),
}).strict();

export type AppointmentAvailabilityQuery = z.infer<typeof appointmentAvailabilityQuerySchema>;
