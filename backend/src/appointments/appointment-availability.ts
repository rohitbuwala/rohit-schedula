import type { AppointmentStatus } from '../db/schema.js';

export const APPOINTMENT_SLOT_MINUTES = 30;
const SLOT_MS = APPOINTMENT_SLOT_MINUTES * 60_000;
const OPEN_HOUR_UTC = 9;
const CLOSE_HOUR_UTC = 17;

export interface ExistingAppointment {
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
}

export interface AppointmentSlot {
  startsAt: Date;
  endsAt: Date;
}

export function candidateSlotsForDate(date: string, now = new Date()): AppointmentSlot[] {
  // Doctor-specific working hours are not modeled yet; use a shared weekday UTC schedule.
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayOfWeek = dayStart.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return [];

  const slots: AppointmentSlot[] = [];
  for (let hour = OPEN_HOUR_UTC; hour < CLOSE_HOUR_UTC; hour += 1) {
    for (const minute of [0, 30]) {
      const startsAt = new Date(dayStart);
      startsAt.setUTCHours(hour, minute, 0, 0);
      const endsAt = new Date(startsAt.getTime() + SLOT_MS);
      if (startsAt > now) slots.push({ startsAt, endsAt });
    }
  }
  return slots;
}

export function getAvailableSlots(date: string, appointments: ExistingAppointment[], now = new Date()): AppointmentSlot[] {
  return candidateSlotsForDate(date, now).filter((slot) => !appointments.some((existing) =>
    existing.status === 'scheduled'
      && slot.startsAt < existing.endsAt
      && existing.startsAt < slot.endsAt));
}

export function isBookableSlot(startsAt: Date, endsAt: Date, now = new Date()): boolean {
  const date = startsAt.toISOString().slice(0, 10);
  return candidateSlotsForDate(date, now).some((slot) =>
    slot.startsAt.getTime() === startsAt.getTime() && slot.endsAt.getTime() === endsAt.getTime());
}
