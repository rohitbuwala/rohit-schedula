import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { appointmentAvailabilityQuerySchema } from '../appointments/appointment-availability.schema.js';
import { createZonedDate } from '../appointments/appointment-availability.js';
import { AppointmentsService, DEFAULT_SLOT_HORIZON_DAYS, MAX_SLOT_HORIZON_DAYS } from '../appointments/appointments.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { DoctorProfilesService } from '../doctors/doctor-profiles.service.js';
import { DoctorScheduleService } from '../doctors/doctor-schedule.service.js';
import type { assistantRescheduleSchema, AssistantCancellationReason, AssistantTool } from './assistant.schema.js';

const uuidSchema = z.uuid();
const dateSchema = z.iso.date();
const uuidPattern = /\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi;
const datePattern = /\b\d{4}-\d{2}-\d{2}\b/g;
const timePattern = /\b\d{1,2}:\d{2}(?::\d+)?\b/g;
const timestampPattern = /\b\d{4}-\d{2}-\d{2}T[^\s,;!?]+/g;
const timestampSchema = z.iso.datetime({ offset: true }).refine((value) => {
  const year = new Date(value).getUTCFullYear();
  return year >= 1 && year <= 9999;
});
const MAX_CONFLICT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const searchStopWords = new Set(
  'a alternative alternatives an any are at available availability by can check consult consultation could date dr doctor doctors find for free give has have i if in is list look me name nearby of on open openings please requested search see show slot slots specialist specialty suggest suggestions tell the time to unavailable want what when which with would you'.split(' '),
);

function words(value: string) {
  return value.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function references(message: string, pattern: RegExp) {
  return [...new Set(message.match(pattern) ?? [])];
}

function clarification(reply: string) {
  return { tool: 'clarify', reply, data: null } as const;
}

function doctorDateFormatter(timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone === 'IST' ? 'Asia/Kolkata' : timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch {
    throw new ServiceUnavailableException('Your schedule timezone is invalid.');
  }
}

@Injectable()
export class AssistantToolsService {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly profiles: DoctorProfilesService,
    private readonly schedules: DoctorScheduleService,
  ) {}

  async cancelAppointment(actor: AuthenticatedUser, id: string, reason: AssistantCancellationReason) {
    const reasons: Record<AssistantCancellationReason, string> = {
      schedule_conflict: 'Schedule conflict',
      no_longer_needed: 'Appointment no longer needed',
      other: 'Other',
    };
    await this.appointments.cancel(id, actor, `Appointment cancelled by patient: ${reasons[reason]}`);
    return { status: 'cancelled' } as const;
  }

  rescheduleOptions(actor: AuthenticatedUser, id: string) {
    return this.appointments.suggestPatientRescheduleSlots(actor, id);
  }

  async rescheduleAppointment(actor: AuthenticatedUser, input: z.output<typeof assistantRescheduleSchema>) {
    const updated = await this.appointments.reschedule(input.appointmentId, actor, input.slot, input.expectedStartsAt);
    return { startsAt: updated.startsAt, endsAt: updated.endsAt };
  }

  private async doctorDay(doctorId: string, date?: string, tomorrow = false) {
    const schedule = await this.schedules.getSchedule(doctorId);
    const formatter = doctorDateFormatter(schedule.timezone);
    const { timeZone: timezone } = formatter.resolvedOptions();
    if (date) return { date, timezone };
    const parts = formatter.formatToParts(new Date());
    const part = (type: string) => parts.find((value) => value.type === type)?.value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    if (!tomorrow) return { date: today, timezone };
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1);
    return { date: day.toISOString().slice(0, 10), timezone };
  }

  private async searchDoctors(message: string) {
    const terms = words(message.replace(datePattern, ' ').replace(uuidPattern, ' ').replace(timePattern, ' '))
      .filter((word) => !searchStopWords.has(word));
    if (!terms.length) return null;
    const profiles = await this.profiles.listPublicProfiles();
    return profiles.filter((profile) => {
      const profileWords = words(`${profile.name} ${profile.specialty}`);
      return terms.every((term) => {
        const specialty = term.replace(/ologist(?:s)?$/, 'ology');
        return profileWords.some((word) => word.startsWith(term) || word === specialty);
      });
    }).map(({ id, name, specialty, consultationFeeInr }) => ({ id, name, specialty, consultationFeeInr }));
  }

  async execute(tool: AssistantTool, actor: AuthenticatedUser, message: string) {
    switch (tool) {
      case 'payment_history': {
        const data = await this.appointments.listPatientPaymentHistory(actor);
        return { tool, reply: data.payments.length ? 'Here is your payment and refund history.' : 'You have no payments on file.', data };
      }
      case 'list_prescriptions': {
        const data = await this.appointments.listPatientPrescriptions(actor);
        return { tool, reply: data.prescriptions.length ? 'Here are your prescriptions.' : 'You have no prescriptions on file.', data };
      }
      case 'list_appointments': {
        const upcoming = /\b(?:upcoming|future)\b/i.test(message);
        const past = /\b(?:past|previous|history)\b/i.test(message);
        const filter = /\breschedulable appointments\b/i.test(message) ? 'reschedulable'
          : /\bcancellable appointments\b/i.test(message) ? 'cancellable' : upcoming === past ? 'all' : upcoming ? 'upcoming' : 'past';
        const rows = await this.appointments.listMineReadOnly(actor, { filter });
        const label = filter === 'all' ? 'appointments' : `${filter} appointments`;
        return { tool, reply: rows.length ? `Here are your ${label}.` : `You have no ${label}.`,
          data: { filter, appointments: rows.slice(0, 50), hasMore: rows.length > 50 } };
      }
      case 'search_doctors': {
        const doctors = await this.searchDoctors(message);
        if (!doctors) return clarification('Which doctor or specialty should I look for?');
        return { tool, reply: doctors.length ? 'Here are the matching doctors.' : 'No matching doctors found.',
          data: { doctors: doctors.slice(0, 20), hasMore: doctors.length > 20 } };
      }
      case 'alternative_slots':
      case 'check_availability': {
        const dates = references(message, datePattern);
        if (dates.length !== 1 || !dateSchema.safeParse(dates[0]).success) {
          return clarification('Enter one date in YYYY-MM-DD format to check availability.');
        }
        const times = references(message, timePattern);
        const [time] = times;
        const [hour, minute] = time ? time.split(':').map(Number) : [-1, -1];
        if (times.length > 1 || (time && (!/^\d{1,2}:\d{2}$/.test(time) || hour > 23 || minute > 59 || /\b(?:am|pm)\b/i.test(message))) ||
            (!time && (tool === 'alternative_slots' || /\b\d{1,2}:\d|\b\d{1,2}\s*(?:am|pm)\b/i.test(message)))) {
          return clarification('Enter one requested time in 24-hour HH:mm format.');
        }
        const ids = references(message, uuidPattern);
        if (ids.length > 1) return clarification('Which doctor should I check?');
        const matches = ids.length ? null : await this.searchDoctors(message);
        const doctorProfileId = ids[0] ?? (matches?.length === 1 ? matches[0].id : undefined);
        if (!doctorProfileId) return clarification('Enter a unique doctor name or doctor profile ID.');
        const query = appointmentAvailabilityQuerySchema.safeParse({ doctorProfileId, date: dates[0] });
        if (!query.success) return clarification('Enter a valid doctor profile ID and date.');
        const data = await this.appointments.getAvailableSlots(actor.id, query.data);
        if (!time) return { tool: 'check_availability' as const,
          reply: data.slots.length ? 'Here are the available slots.' : 'There are no open slots for that date.', data };
        const requested = createZonedDate(data.date, hour, minute, data.timezone).getTime();
        const open = data.slots.find((slot) => Date.parse(slot.startsAt) === requested);
        if (open) return { tool: 'check_availability' as const, reply: 'Your requested slot is available.', data: { ...data, slots: [open] } };
        const distance = (slot: { startsAt: string }) => Math.abs(Date.parse(slot.startsAt) - requested);
        const slots = [...data.slots].sort((a, b) => distance(a) - distance(b) || Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 3);
        return { tool: 'alternative_slots' as const,
          reply: slots.length ? 'That slot is unavailable. Here are the closest open slots on the same date.' : 'That slot is unavailable, and there are no alternatives on that date.',
          data: { ...data, slots } };
      }
      case 'next_available_slot': {
        const horizons = [...message.matchAll(/(?<![\w.,+-])([+-]?\d+(?:\.\d+)?)\s*days?\b/gi)];
        const horizonDays = horizons.length === 1 ? Number(horizons[0][1]) : DEFAULT_SLOT_HORIZON_DAYS;
        if (horizons.length > 1 || (!horizons.length && /\bdays?\b/i.test(message)) ||
            !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > MAX_SLOT_HORIZON_DAYS) {
          return clarification(`Enter a search horizon from 1 to ${MAX_SLOT_HORIZON_DAYS} days, or leave it out for the default.`);
        }
        const result = await this.appointments.findNextDoctorSlot(actor, horizonDays);
        return {
          tool,
          reply: result.slot ? 'Here is your next available slot.' : `No available slots found in the ${horizonDays}-day search window.`,
          data: { ...result, horizonDays },
        };
      }
      case 'today_appointments': {
        if (!/\btomorrow\b/i.test(message) && !references(message, datePattern).length) {
          const { date, timezone } = await this.doctorDay(actor.id);
          const rows = await this.appointments.listMineReadOnly(actor, { date, timezone });
          return { tool, reply: rows.length ? "Here are today's appointments." : 'You have no appointments today.',
            data: { date, timezone, appointments: rows.slice(0, 50), hasMore: rows.length > 50 } };
        }
        return this.appointmentsByDate(actor, message);
      }
      case 'doctor_appointments_by_date': {
        return this.appointmentsByDate(actor, message);
      }
      case 'appointment_statistics': {
        const dates = references(message, datePattern);
        const today = /\btoday\b/i.test(message);
        const [date] = dates;
        const validDate = date && !date.startsWith('0000-') && dateSchema.safeParse(date).success;
        if (!(today ? dates.length === 0 : dates.length === 1 && validDate)) {
          return clarification('Enter today or one date in YYYY-MM-DD format for appointment statistics.');
        }
        const day = await this.doctorDay(actor.id, date);
        const stats = await this.appointments.countDoctorAppointmentsByStatus(actor, day);
        return { tool, reply: 'Here are your appointment statistics.', data: { ...day, ...stats } };
      }
      case 'schedule_conflicts': {
        const [start, end, ...extra] = (message.match(timestampPattern) ?? []).map((value) =>
          value.replace(/\.$/, '').replace(/(T\d{2}:\d{2})(?=Z$|[+-]\d{2}:\d{2}$)/, '$1:00'));
        if (extra.length || !timestampSchema.safeParse(start).success || !timestampSchema.safeParse(end).success) {
          return clarification('Enter two ISO timestamps with timezones, for example 2026-11-12T09:00+05:30 and 2026-11-12T10:00+05:30.');
        }
        const startsAt = new Date(start);
        const endsAt = new Date(end);
        const duration = endsAt.getTime() - startsAt.getTime();
        if (!(duration > 0 && duration <= MAX_CONFLICT_RANGE_MS)) {
          return clarification('Enter an end time after the start time and a range of at most seven days.');
        }
        const schedule = await this.schedules.getSchedule(actor.id);
        const { timeZone: timezone } = doctorDateFormatter(schedule.timezone).resolvedOptions();
        const result = await this.schedules.checkTimeRangeConflicts(actor.id, { startsAt, endsAt });
        return {
          tool,
          reply: result.conflicts.length ? 'These scheduled appointments overlap the requested range.' : 'No scheduled appointments overlap the requested range.',
          data: { startsAt, endsAt, timezone, ...result },
        };
      }
      case 'reschedule_suggestions': {
        const ids = references(message, uuidPattern);
        if (ids.length !== 1 || !uuidSchema.safeParse(ids[0]).success) {
          return clarification('Select one appointment or enter its appointment ID to see alternative slots.');
        }
        const result = await this.appointments.suggestDoctorRescheduleSlots(actor, ids[0]);
        return {
          tool,
          reply: result.slots.length ? 'Here are alternative slots. Your appointment has not changed.' : 'No alternative slots were found in the next 30 calendar days.',
          data: result,
        };
      }
      case 'appointment_details': {
        const ids = references(message, uuidPattern);
        if (ids.length !== 1 || !uuidSchema.safeParse(ids[0]).success) {
          return clarification('Enter one appointment ID to view its details.');
        }
        const appointment = await this.appointments.getMineReadOnly(ids[0], actor);
        const schedule = await this.schedules.getSchedule(actor.id);
        const { timeZone: timezone } = doctorDateFormatter(schedule.timezone).resolvedOptions();
        return { tool, reply: 'Here are the appointment details.', data: { ...appointment, timezone } };
      }
      case 'view_schedule': {
        const { timezone, activeDays, startHour, endHour, slotDurationMinutes, breakStart, breakEnd, leaves } =
          await this.schedules.getSchedule(actor.id);
        return { tool, reply: 'Here is your schedule.', data: {
          timezone, activeDays, startHour, endHour, slotDurationMinutes, breakStart, breakEnd,
          leaveDates: leaves.map(({ date }) => date),
        } };
      }
    }
  }

  private async appointmentsByDate(actor: AuthenticatedUser, message: string) {
    const dates = references(message, datePattern);
    const today = /\btoday\b/i.test(message);
    const tomorrow = /\btomorrow\b/i.test(message);
    const [date] = dates;
    if (Number(today) + Number(tomorrow) + dates.length !== 1 ||
        (date && (date.startsWith('0000-') || !dateSchema.safeParse(date).success))) {
      return clarification('Enter today, tomorrow, or one date in YYYY-MM-DD format.');
    }
    const day = await this.doctorDay(actor.id, date, tomorrow);
    const rows = await this.appointments.listMineReadOnly(actor, day);
    return {
      tool: 'doctor_appointments_by_date',
      reply: rows.length ? 'Here are your appointments for that date.' : 'You have no appointments on that date.',
      data: { ...day, appointments: rows.slice(0, 50).map(({ startsAt, endsAt, status }) => ({ startsAt, endsAt, status })),
        hasMore: rows.length > 50 },
    } as const;
  }
}
