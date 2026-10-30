import { z } from 'zod';

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const doctorScheduleUpdateSchema = z.object({
  timezone: z.string().min(1).default('Asia/Kolkata'),
  activeDays: z.array(z.number().int().min(0).max(6)).min(1),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  slotDurationMinutes: z.union([z.literal(15), z.literal(30)]).default(30),
  breakStart: z.string().regex(timeRegex, 'Must be HH:MM format').nullable().optional(),
  breakEnd: z.string().regex(timeRegex, 'Must be HH:MM format').nullable().optional(),
}).strict().refine((data) => data.endHour > data.startHour, {
  message: 'End hour must be greater than start hour.',
  path: ['endHour'],
}).refine((data) => {
  if (data.breakStart && data.breakEnd) {
    return data.breakEnd > data.breakStart;
  }
  return true;
}, {
  message: 'Break end must be after break start.',
  path: ['breakEnd'],
});

export const doctorLeaveInputSchema = z.object({
  date: z.iso.date(),
  reason: z.string().max(200).optional(),
}).strict();

export type DoctorScheduleUpdate = z.infer<typeof doctorScheduleUpdateSchema>;
export type DoctorLeaveInput = z.infer<typeof doctorLeaveInputSchema>;
