import type { AppointmentStatus } from '../db/schema.js';

export const APPOINTMENT_SLOT_MINUTES = 30;
export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 17;
export const OPEN_HOUR_UTC = 9;
export const CLOSE_HOUR_UTC = 17;
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

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

export function createZonedDate(dateStr: string, hour: number, minute: number, timeZone = 'Asia/Kolkata'): Date {
  const pad = (n: number) => String(n).padStart(2, '0');
  const localIso = `${dateStr}T${pad(hour)}:${pad(minute)}:00`;
  if (timeZone === 'Asia/Kolkata' || timeZone === 'IST') {
    return new Date(`${localIso}+05:30`);
  }
  if (timeZone === 'UTC' || !timeZone) {
    return new Date(`${localIso}Z`);
  }
  try {
    const d = new Date(`${dateStr}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(d);
    const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value;
    const offset = tzPart ? tzPart.replace('GMT', '') : 'Z';
    return new Date(`${localIso}${offset || 'Z'}`);
  } catch {
    return new Date(`${localIso}Z`);
  }
}

export function getDayOfWeekForDate(dateStr: string, timeZone = 'Asia/Kolkata'): number {
  if (timeZone === 'UTC') {
    return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
  }
  const midDay = createZonedDate(dateStr, 12, 0, timeZone);
  const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(midDay);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return dayMap[weekdayStr] ?? midDay.getUTCDay();
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

  const timeZone = config?.timezone ?? 'UTC';
  const dayOfWeek = getDayOfWeekForDate(date, timeZone);

  // Active days: defaults to weekdays (1 through 5: Mon..Fri)
  const activeDays = config?.activeDays ?? [1, 2, 3, 4, 5];
  if (!activeDays.includes(dayOfWeek)) {
    return [];
  }

  const startHour = config?.startHour ?? OPEN_HOUR;
  const endHour = config?.endHour ?? CLOSE_HOUR;
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
    const startsAt = createZonedDate(date, hour, minute, timeZone);
    const endsAt = new Date(startsAt.getTime() + slotMs);

    if (startsAt.getTime() > now.getTime()) {
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
          slot.startsAt.getTime() < existing.endsAt.getTime() &&
          existing.startsAt.getTime() < slot.endsAt.getTime()
      )
  );
}

export function isBookableSlot(
  startsAt: Date,
  endsAt: Date,
  now = new Date(),
  config?: DoctorScheduleConfig
): boolean {
  if (startsAt.getTime() <= now.getTime() || endsAt.getTime() <= startsAt.getTime()) {
    return false;
  }

  const tz = config?.timezone ?? 'Asia/Kolkata';
  const dateInTz = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(startsAt);

  if (config?.slotDurationMinutes) {
    return candidateSlotsForDate(dateInTz, now, config).some(
      (slot) =>
        slot.startsAt.getTime() === startsAt.getTime() &&
        slot.endsAt.getTime() === endsAt.getTime()
    );
  }

  // When slot duration is not specified in config, accept either 15-minute or 30-minute slots
  const slots15 = candidateSlotsForDate(dateInTz, now, { ...config, timezone: tz, slotDurationMinutes: 15 });
  if (slots15.some((s) => s.startsAt.getTime() === startsAt.getTime() && s.endsAt.getTime() === endsAt.getTime())) {
    return true;
  }
  const slots30 = candidateSlotsForDate(dateInTz, now, { ...config, timezone: tz, slotDurationMinutes: 30 });
  return slots30.some((s) => s.startsAt.getTime() === startsAt.getTime() && s.endsAt.getTime() === endsAt.getTime());
}
