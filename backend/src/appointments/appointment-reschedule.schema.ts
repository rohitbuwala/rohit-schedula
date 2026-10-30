import { z } from 'zod';

export const appointmentRescheduleSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  endsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
}).strict().refine(({ startsAt, endsAt }) => endsAt > startsAt, {
  path: ['endsAt'],
  message: 'End time must be after start time.',
}).refine(({ startsAt }) => startsAt instanceof Date && Number.isFinite(startsAt.getTime()) && startsAt.getTime() > Date.now(), {
  path: ['startsAt'],
  message: 'Appointment start time must be in the future.',
});

export type AppointmentRescheduleInput = z.infer<typeof appointmentRescheduleSchema>;
