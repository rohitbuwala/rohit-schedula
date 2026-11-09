import type { AppointmentStatus } from '../db/schema.js';

export const APPOINTMENT_SLOT_MINUTES = 30;
export const STREAM_SLOT_MINUTES = 15;
export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 17;
export const OPEN_HOUR_UTC = 9;
export const CLOSE_HOUR_UTC = 17;
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export interface ExistingAppointment {
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  holdExpiresAt?: Date | null;
}

export interface AppointmentSlot {
  startsAt: Date;
  endsAt: Date;
}

export type SchedulingMode = 'wave' | 'stream';

export interface AvailableAppointmentSlot extends AppointmentSlot {
  mode: SchedulingMode;
  slotId: string;
  sessionId: string | null;
  capacity: number;
  remainingCapacity: number;
}

export interface DoctorScheduleConfig {
  timezone?: string;
  activeDays?: number[]; // 0=Sun, 1=Mon, ..., 6=Sat (default [1, 2, 3, 4, 5])
  startHour?: number; // default 9
  endHour?: number; // default 17
  slotDurationMinutes?: number; // default 30
  schedulingMode?: SchedulingMode;
  capacity?: number;
  breakStart?: string | null; // e.g. "13:00"
  breakEnd?: string | null; // e.g. "14:00"
  leaveDates?: string[]; // array of "YYYY-MM-DD"
  dateOverrides?: Array<{
    date: string;
    startHour: number;
    endHour: number;
    slotDurationMinutes: number;
    schedulingMode?: SchedulingMode | null;
    capacity?: number | null;
    breakStart: string | null;
    breakEnd: string | null;
  }>;
}

export function createZonedDate(dateStr: string, hour: number, minute: number, timeZone = 'Asia/Kolkata'): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute);
  if (timeZone === 'UTC' || !timeZone) return new Date(targetUtc);
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const offsets = new Set<number>();
    const probeHours = [-36, -24, -12, 0, 12, 24, 36];
    for (const probeHour of probeHours) {
      const probe = new Date(targetUtc + probeHour * 60 * 60_000);
      const parts = Object.fromEntries(formatter.formatToParts(probe).map(({ type, value }) => [type, Number(value)]));
      const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      offsets.add(representedUtc - probe.getTime());
    }

    const matchingInstants = [...offsets]
      .map((offset) => targetUtc - offset)
      .filter((candidate) => {
        const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(({ type, value }) => [type, Number(value)]));
        return parts.year === year && parts.month === month && parts.day === day &&
          parts.hour === hour && parts.minute === minute && parts.second === 0;
      })
      .sort((left, right) => left - right);

    // A spring-forward gap has no matching instant. For a fall-back fold,
    // choose the earlier instant so the same local time is always deterministic.
    return matchingInstants.length > 0 ? new Date(matchingInstants[0]!) : new Date(Number.NaN);
  } catch {
    return new Date(targetUtc);
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

  const override = config?.dateOverrides?.find((entry) => entry.date === date);
  const timeZone = config?.timezone ?? 'UTC';
  const dayOfWeek = getDayOfWeekForDate(date, timeZone);

  // Active days: defaults to weekdays (1 through 5: Mon..Fri)
  const activeDays = override ? [dayOfWeek] : (config?.activeDays ?? [1, 2, 3, 4, 5]);
  if (!activeDays.includes(dayOfWeek)) {
    return [];
  }

  const startHour = override?.startHour ?? config?.startHour ?? OPEN_HOUR;
  const endHour = override?.endHour ?? config?.endHour ?? CLOSE_HOUR;
  const mode = override?.schedulingMode ?? config?.schedulingMode;
  const durationMinutes = mode === 'stream'
    ? STREAM_SLOT_MINUTES
    : override?.slotDurationMinutes ?? config?.slotDurationMinutes ?? APPOINTMENT_SLOT_MINUTES;
  const slotMs = durationMinutes * 60_000;

  // Parse break hours if configured
  let breakStartMinutes: number | null = null;
  let breakEndMinutes: number | null = null;
  const breakStart = override ? override.breakStart : config?.breakStart;
  const breakEnd = override ? override.breakEnd : config?.breakEnd;
  if (breakStart && breakEnd) {
    const [bsh, bsm] = breakStart.split(':').map(Number);
    const [beh, bem] = breakEnd.split(':').map(Number);
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
    if (!Number.isFinite(startsAt.getTime())) continue;
    const endsAt = new Date(startsAt.getTime() + slotMs);

    if (startsAt.getTime() > now.getTime()) {
      slots.push({ startsAt, endsAt });
    }
  }

  return slots;
}

export function isAppointmentBusy(
  existing: ExistingAppointment,
  now = new Date()
): boolean {
  if (existing.status === 'scheduled') return true;
  if (existing.status === 'pending_payment') {
    return existing.holdExpiresAt ? existing.holdExpiresAt.getTime() > now.getTime() : true;
  }
  return false;
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
          isAppointmentBusy(existing, now) &&
          slot.startsAt.getTime() < existing.endsAt.getTime() &&
          existing.startsAt.getTime() < slot.endsAt.getTime()
      )
  );
}

export function getAvailableSlotsWithCapacity(
  date: string,
  appointments: ExistingAppointment[],
  now = new Date(),
  config?: DoctorScheduleConfig,
): AvailableAppointmentSlot[] {
  const override = config?.dateOverrides?.find((entry) => entry.date === date);
  const mode = override?.schedulingMode ?? config?.schedulingMode ?? 'stream';
  const capacity = override?.capacity ?? config?.capacity ?? 1;
  return candidateSlotsForDate(date, now, config).flatMap((slot) => {
    const occupied = appointments.filter((existing) =>
      isAppointmentBusy(existing, now) &&
      slot.startsAt.getTime() < existing.endsAt.getTime() &&
      existing.startsAt.getTime() < slot.endsAt.getTime(),
    ).length;
    const remainingCapacity = Math.max(0, capacity - occupied);
    if (remainingCapacity === 0) return [];
    const startsAt = slot.startsAt.toISOString();
    const endsAt = slot.endsAt.toISOString();
    const slotId = `${startsAt}/${endsAt}`;
    return [{
      ...slot,
      mode,
      slotId,
      sessionId: mode === 'wave' ? slotId : null,
      capacity,
      remainingCapacity,
    }];
  });
}

export function getCapacityForDate(date: string, config?: DoctorScheduleConfig): number {
  const override = config?.dateOverrides?.find((entry) => entry.date === date);
  return override?.capacity ?? config?.capacity ?? 1;
}

export function getDurationForDate(date: string, config?: DoctorScheduleConfig): number {
  const override = config?.dateOverrides?.find((entry) => entry.date === date);
  const mode = override?.schedulingMode ?? config?.schedulingMode;
  return mode === 'stream'
    ? STREAM_SLOT_MINUTES
    : override?.slotDurationMinutes ?? config?.slotDurationMinutes ?? APPOINTMENT_SLOT_MINUTES;
}

export function getModeForDate(date: string, config?: DoctorScheduleConfig): SchedulingMode {
  const override = config?.dateOverrides?.find((entry) => entry.date === date);
  return override?.schedulingMode ?? config?.schedulingMode ?? 'stream';
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

  return candidateSlotsForDate(dateInTz, now, { ...config, timezone: tz }).some(
    (slot) =>
      slot.startsAt.getTime() === startsAt.getTime() &&
      slot.endsAt.getTime() === endsAt.getTime()
  );
}
