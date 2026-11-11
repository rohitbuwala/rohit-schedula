import { z } from 'zod';

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isSupportedTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export const doctorScheduleUpdateSchema = z.object({
  timezone: z.string().trim().min(1).refine(isSupportedTimezone, 'Must be a supported IANA timezone.').default('Asia/Kolkata'),
  activeDays: z.array(z.number().int().min(0).max(6)).min(1),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  slotDurationMinutes: z.union([z.literal(15), z.literal(30)]).optional(),
  schedulingMode: z.enum(['wave', 'stream']).default('stream'),
  capacity: z.number().int().min(1).max(100).default(1),
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
}).refine((data) => data.schedulingMode === 'stream' || data.slotDurationMinutes !== undefined, {
  message: 'Appointment duration is required for Wave scheduling.',
  path: ['slotDurationMinutes'],
});

export const doctorLeaveInputSchema = z.object({
  date: z.iso.date(),
  reason: z.string().max(200).optional(),
}).strict();

export const doctorScheduleOverrideInputSchema = z.object({
  date: z.iso.date(),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  slotDurationMinutes: z.union([z.literal(15), z.literal(30)]).optional(),
  schedulingMode: z.enum(['wave', 'stream']).nullable().optional(),
  capacity: z.number().int().min(1).max(100).nullable().optional(),
  breakStart: z.string().regex(timeRegex, 'Must be HH:MM format').nullable().optional(),
  breakEnd: z.string().regex(timeRegex, 'Must be HH:MM format').nullable().optional(),
}).strict().refine((data) => data.endHour > data.startHour, {
  message: 'End hour must be greater than start hour.',
  path: ['endHour'],
}).refine((data) => {
  if (data.breakStart && data.breakEnd) return data.breakEnd > data.breakStart;
  return !data.breakStart && !data.breakEnd;
}, {
  message: 'Provide a valid break start and end.',
  path: ['breakEnd'],
}).refine((data) => data.schedulingMode !== 'wave' || data.slotDurationMinutes !== undefined, {
  message: 'Appointment duration is required for Wave scheduling.',
  path: ['slotDurationMinutes'],
});

export const scheduleRequestRejectionSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

export const scheduleAlternativeSelectionSchema = z.object({
  alternativeIds: z.array(z.uuid()).min(1).max(5),
}).strict();

export type DoctorScheduleUpdate = z.infer<typeof doctorScheduleUpdateSchema>;
export type DoctorLeaveInput = z.infer<typeof doctorLeaveInputSchema>;
export type DoctorScheduleOverrideInput = z.infer<typeof doctorScheduleOverrideInputSchema>;
export type ScheduleRequestRejection = z.infer<typeof scheduleRequestRejectionSchema>;
export type ScheduleAlternativeSelection = z.infer<typeof scheduleAlternativeSelectionSchema>;
