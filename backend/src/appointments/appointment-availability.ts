import type { AppointmentStatus } from '../db/schema.js';

export const APPOINTMENT_SLOT_MINUTES = 30;
export const OPEN_HOUR_UTC = 9;
export const CLOSE_HOUR_UTC = 17;

export interface ExistingAppointment {
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
}

export interface AppointmentSlot {
  startsAt: Date;
  endsAt: Date;
}

export interface DoctorScheduleConfig {
  timezone?: string;
  activeDays?: number[]; // 0=Sun, 1=Mon, ..., 6=Sat (default [1, 2, 3, 4, 5])
  startHour?: number; // default 9
  endHour?: number; // default 17
  slotDurationMinutes?: number; // default 30
  breakStart?: string | null; // e.g. "13:00"
  breakEnd?: string | null; // e.g. "14:00"
  leaveDates?: string[]; // array of "YYYY-MM-DD"
}

export function candidateSlotsForDate(
  date: string,
  now = new Date(),
  config?: DoctorScheduleConfig
): AppointmentSlot[] {
  // If date is marked as doctor leave, no slots are available
  if (config?.leaveDates && config.leaveDates.includes(date)) {
    return [];
  }

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayOfWeek = dayStart.getUTCDay();

  // Active days: defaults to weekdays (1 through 5: Mon..Fri)
  const activeDays = config?.activeDays ?? [1, 2, 3, 4, 5];
  if (!activeDays.includes(dayOfWeek)) {
    return [];
  }

  const startHour = config?.startHour ?? OPEN_HOUR_UTC;
  const endHour = config?.endHour ?? CLOSE_HOUR_UTC;
  const durationMinutes = config?.slotDurationMinutes ?? APPOINTMENT_SLOT_MINUTES;
  const slotMs = durationMinutes * 60_000;

  // Parse break hours if configured
  let breakStartMinutes: number | null = null;
  let breakEndMinutes: number | null = null;
  if (config?.breakStart && config?.breakEnd) {
    const [bsh, bsm] = config.breakStart.split(':').map(Number);
    const [beh, bem] = config.breakEnd.split(':').map(Number);
    if (!Number.isNaN(bsh) && !Number.isNaN(bsm) && !Number.isNaN(beh) && !Number.isNaN(bem)) {
      breakStartMinutes = bsh * 60 + bsm;
      breakEndMinutes = beh * 60 + bem;
    }
  }

  const slots: AppointmentSlot[] = [];
  const startTotalMinutes = startHour * 60;
  const endTotalMinutes = endHour * 60;

  for (let current = startTotalMinutes; current + durationMinutes <= endTotalMinutes; current += durationMinutes) {
    // Check if current slot falls into the configured break interval
    if (breakStartMinutes !== null && breakEndMinutes !== null) {
      const slotStartM = current;
      const slotEndM = current + durationMinutes;
      // Overlaps if slot starts before break ends AND slot ends after break starts
      if (slotStartM < breakEndMinutes && slotEndM > breakStartMinutes) {
        continue;
      }
    }

    const hour = Math.floor(current / 60);
    const minute = current % 60;
    const startsAt = new Date(dayStart);
    startsAt.setUTCHours(hour, minute, 0, 0);
    const endsAt = new Date(startsAt.getTime() + slotMs);

    if (startsAt > now) {
      slots.push({ startsAt, endsAt });
    }
  }

  return slots;
}

export function getAvailableSlots(
  date: string,
  appointments: ExistingAppointment[],
  now = new Date(),
  config?: DoctorScheduleConfig
): AppointmentSlot[] {
  return candidateSlotsForDate(date, now, config).filter(
    (slot) =>
      !appointments.some(
        (existing) =>
          existing.status === 'scheduled' &&
          slot.startsAt < existing.endsAt &&
          existing.startsAt < slot.endsAt
      )
  );
}

export function isBookableSlot(
  startsAt: Date,
  endsAt: Date,
  now = new Date(),
  config?: DoctorScheduleConfig
): boolean {
  const date = startsAt.toISOString().slice(0, 10);
  return candidateSlotsForDate(date, now, config).some(
    (slot) =>
      slot.startsAt.getTime() === startsAt.getTime() &&
      slot.endsAt.getTime() === endsAt.getTime()
  );
}
