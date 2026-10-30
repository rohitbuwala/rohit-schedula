import { z } from 'zod';
import { isBookableSlot } from './appointment-availability.js';

export const appointmentBookingSchema = z.object({
  doctorProfileId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  endsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
}).strict().refine(({ startsAt, endsAt }) => endsAt > startsAt, {
  path: ['endsAt'], message: 'End time must be after start time.',
}).refine(({ startsAt }) => startsAt instanceof Date && Number.isFinite(startsAt.getTime()) && startsAt.getTime() > Date.now(), {
  path: ['startsAt'], message: 'Appointment start time must be in the future.',
}).refine(({ startsAt, endsAt }) => startsAt instanceof Date && endsAt instanceof Date && isBookableSlot(startsAt, endsAt), {
  path: ['startsAt'], message: 'Choose a valid weekday slot between 09:00 and 17:00 IST.',
});
