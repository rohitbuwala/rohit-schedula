import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, or } from 'drizzle-orm';
import { db } from '../db/database.js';
import { appointment, doctorAvailability, doctorLeave, doctorScheduleOverride, doctorProfile } from '../db/schema.js';
import type { DoctorScheduleConfig } from '../appointments/appointment-availability.js';
import type { DoctorScheduleUpdate, DoctorLeaveInput, DoctorScheduleOverrideInput } from './doctor-schedule.schema.js';

export interface DoctorLeaveRecord {
  id: string;
  date: string;
  reason?: string;
  createdAt: string;
}

export interface DoctorScheduleOverrideRecord {
  id: string;
  date: string;
  startHour: number;
  endHour: number;
  slotDurationMinutes: number;
  schedulingMode: 'wave' | 'stream' | null;
  capacity: number | null;
  breakStart: string | null;
  breakEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DoctorScheduleData {
  timezone: string;
  activeDays: number[];
  startHour: number;
  endHour: number;
  slotDurationMinutes: number;
  schedulingMode: 'wave' | 'stream';
  capacity: number;
  breakStart: string | null;
  breakEnd: string | null;
  leaves: DoctorLeaveRecord[];
  overrides: DoctorScheduleOverrideRecord[];
}

const DEFAULT_SCHEDULE = {
  timezone: 'Asia/Kolkata',
  activeDays: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 17,
  slotDurationMinutes: 30,
  schedulingMode: 'stream' as const,
  capacity: 1,
  breakStart: null,
  breakEnd: null,
} as const;

@Injectable()
export class DoctorScheduleService {
  private async lockSchedule(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], doctorId: string): Promise<void> {
    await tx.select({ id: doctorProfile.id }).from(doctorProfile)
      .where(eq(doctorProfile.userId, doctorId)).for('update').limit(1);
  }

  async getSchedule(doctorId: string): Promise<DoctorScheduleData> {
    const [saved] = await db.select().from(doctorAvailability)
      .where(eq(doctorAvailability.doctorId, doctorId)).limit(1);
    const leaves = await db.select().from(doctorLeave)
      .where(eq(doctorLeave.doctorId, doctorId)).orderBy(asc(doctorLeave.date));
    const overrides = await db.select().from(doctorScheduleOverride)
      .where(eq(doctorScheduleOverride.doctorId, doctorId)).orderBy(asc(doctorScheduleOverride.date));

    return {
      ...DEFAULT_SCHEDULE,
      ...(saved ? {
        timezone: saved.timezone,
        activeDays: saved.activeDays,
        startHour: saved.startHour,
        endHour: saved.endHour,
        slotDurationMinutes: saved.slotDurationMinutes,
        schedulingMode: saved.schedulingMode as 'wave' | 'stream',
        capacity: saved.capacity,
        breakStart: saved.breakStart,
        breakEnd: saved.breakEnd,
      } : {}),
      activeDays: saved ? [...saved.activeDays] : [...DEFAULT_SCHEDULE.activeDays],
      leaves: leaves.map((leave) => ({
        id: leave.id,
        date: leave.date,
        ...(leave.reason ? { reason: leave.reason } : {}),
        createdAt: leave.createdAt.toISOString(),
      })),
      overrides: overrides.map((override) => ({
        id: override.id,
        date: override.date,
        startHour: override.startHour,
        endHour: override.endHour,
        slotDurationMinutes: override.slotDurationMinutes,
        schedulingMode: override.schedulingMode as 'wave' | 'stream' | null,
        capacity: override.capacity,
        breakStart: override.breakStart,
        breakEnd: override.breakEnd,
        createdAt: override.createdAt.toISOString(),
        updatedAt: override.updatedAt.toISOString(),
      })),
    };
  }

  async getTimezoneForDoctor(doctorId: string): Promise<string> {
    const [saved] = await db.select({ timezone: doctorAvailability.timezone }).from(doctorAvailability)
      .where(eq(doctorAvailability.doctorId, doctorId)).limit(1);
    return saved?.timezone ?? DEFAULT_SCHEDULE.timezone;
  }

  async updateSchedule(doctorId: string, update: DoctorScheduleUpdate): Promise<DoctorScheduleData> {
    const now = new Date();
    await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      await tx.insert(doctorAvailability).values({
        id: randomUUID(),
        doctorId,
        timezone: update.timezone,
        activeDays: [...update.activeDays].sort((a, b) => a - b),
        startHour: update.startHour,
        endHour: update.endHour,
        slotDurationMinutes: update.slotDurationMinutes ?? 30,
        schedulingMode: update.schedulingMode,
        capacity: update.capacity,
        breakStart: update.breakStart ?? null,
        breakEnd: update.breakEnd ?? null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: doctorAvailability.doctorId,
        set: {
          timezone: update.timezone,
          activeDays: [...update.activeDays].sort((a, b) => a - b),
          startHour: update.startHour,
          endHour: update.endHour,
          slotDurationMinutes: update.slotDurationMinutes ?? 30,
          schedulingMode: update.schedulingMode,
          capacity: update.capacity,
          breakStart: update.breakStart ?? null,
          breakEnd: update.breakEnd ?? null,
          updatedAt: now,
        },
      });
    });
    return this.getSchedule(doctorId);
  }

  async addLeave(doctorId: string, input: DoctorLeaveInput): Promise<DoctorLeaveRecord> {
    const now = new Date();
    const [saved] = await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      return tx.insert(doctorLeave).values({
        id: randomUUID(), doctorId, date: input.date, reason: input.reason ?? null, createdAt: now,
      }).onConflictDoUpdate({
        target: [doctorLeave.doctorId, doctorLeave.date],
        set: { reason: input.reason ?? null },
      }).returning();
    });
    return {
      id: saved.id,
      date: saved.date,
      ...(saved.reason ? { reason: saved.reason } : {}),
      createdAt: saved.createdAt.toISOString(),
    };
  }

  async removeLeave(doctorId: string, leaveId: string): Promise<void> {
    const [deleted] = await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      return tx.delete(doctorLeave).where(and(
        eq(doctorLeave.doctorId, doctorId),
        or(eq(doctorLeave.id, leaveId), eq(doctorLeave.date, leaveId)),
      )).returning({ id: doctorLeave.id });
    });
    if (!deleted) throw new NotFoundException('Leave record not found.');
  }

  async upsertOverride(doctorId: string, input: DoctorScheduleOverrideInput): Promise<DoctorScheduleOverrideRecord> {
    const now = new Date();
    const values = {
      startHour: input.startHour,
      endHour: input.endHour,
      slotDurationMinutes: input.slotDurationMinutes ?? 30,
      schedulingMode: input.schedulingMode ?? null,
      capacity: input.capacity ?? null,
      breakStart: input.breakStart ?? null,
      breakEnd: input.breakEnd ?? null,
      updatedAt: now,
    };
    const [saved] = await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      return tx.insert(doctorScheduleOverride).values({
        id: randomUUID(), doctorId, date: input.date, ...values, createdAt: now,
      }).onConflictDoUpdate({
        target: [doctorScheduleOverride.doctorId, doctorScheduleOverride.date],
        set: values,
      }).returning();
    });
    return {
      id: saved.id,
      date: saved.date,
      startHour: saved.startHour,
      endHour: saved.endHour,
      slotDurationMinutes: saved.slotDurationMinutes,
      schedulingMode: saved.schedulingMode as 'wave' | 'stream' | null,
      capacity: saved.capacity,
      breakStart: saved.breakStart,
      breakEnd: saved.breakEnd,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  async removeOverride(doctorId: string, date: string): Promise<void> {
    const [deleted] = await db.transaction(async (tx) => {
      await this.lockSchedule(tx, doctorId);
      return tx.delete(doctorScheduleOverride).where(and(
        eq(doctorScheduleOverride.doctorId, doctorId), eq(doctorScheduleOverride.date, date),
      )).returning({ id: doctorScheduleOverride.id });
    });
    if (!deleted) throw new NotFoundException('Schedule override not found.');
  }

  async checkConflicts(doctorId: string, newConfig: DoctorScheduleUpdate) {
    const now = new Date();
    const upcoming = await db.select({
      id: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
    }).from(appointment)
      .where(and(eq(appointment.doctorId, doctorId), eq(appointment.status, 'scheduled'), gte(appointment.startsAt, now)));

    const conflicts: Array<{ id: string; startsAt: Date; reason: string }> = [];
    for (const appt of upcoming) {
      const localParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: newConfig.timezone,
        weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(appt.startsAt);
      const values = Object.fromEntries(localParts.map(({ type, value }) => [type, value]));
      const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const day = dayMap[values.weekday];
      const startMinute = Number(values.hour) * 60 + Number(values.minute);
      const endParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: newConfig.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(appt.endsAt);
      const endValues = Object.fromEntries(endParts.map(({ type, value }) => [type, value]));
      const endMinute = Number(endValues.hour) * 60 + Number(endValues.minute);
      const localStart = `${values.hour}:${values.minute}`;
      if (!newConfig.activeDays.includes(day)) {
        conflicts.push({ id: appt.id, startsAt: appt.startsAt, reason: `Appointment is on a day (${day}) removed from active schedule.` });
        continue;
      }
      if (startMinute < newConfig.startHour * 60 || endMinute > newConfig.endHour * 60) {
        conflicts.push({ id: appt.id, startsAt: appt.startsAt, reason: `Appointment at ${localStart} is outside new working hours in ${newConfig.timezone}.` });
        continue;
      }
      if (newConfig.breakStart && newConfig.breakEnd) {
        const [bsh, bsm] = newConfig.breakStart.split(':').map(Number);
        const [beh, bem] = newConfig.breakEnd.split(':').map(Number);
        if (startMinute < beh * 60 + bem && endMinute > bsh * 60 + bsm) {
          conflicts.push({ id: appt.id, startsAt: appt.startsAt, reason: `Appointment overlaps with new break window (${newConfig.breakStart} - ${newConfig.breakEnd}).` });
        }
      }
    }
    return { hasConflicts: conflicts.length > 0, conflictCount: conflicts.length, conflicts };
  }

  async getScheduleConfigForProfile(doctorProfileId: string): Promise<DoctorScheduleConfig> {
    const [doc] = await db.select({ userId: doctorProfile.userId })
      .from(doctorProfile).where(eq(doctorProfile.id, doctorProfileId)).limit(1);
    if (!doc) return {};
    return this.getScheduleConfigForDoctor(doc.userId);
  }

  async getScheduleConfigForDoctor(doctorId: string): Promise<DoctorScheduleConfig> {
    const schedule = await this.getSchedule(doctorId);
    return {
      timezone: schedule.timezone,
      activeDays: schedule.activeDays,
      startHour: schedule.startHour,
      endHour: schedule.endHour,
      slotDurationMinutes: schedule.slotDurationMinutes,
      schedulingMode: schedule.schedulingMode,
      capacity: schedule.capacity,
      breakStart: schedule.breakStart,
      breakEnd: schedule.breakEnd,
      leaveDates: schedule.leaves.map((leave) => leave.date),
      dateOverrides: schedule.overrides,
    };
  }
}
