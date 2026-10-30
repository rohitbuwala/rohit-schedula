import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/database.js';
import { appointment, doctorProfile } from '../db/schema.js';
import type { DoctorScheduleConfig } from '../appointments/appointment-availability.js';
import type { DoctorScheduleUpdate, DoctorLeaveInput } from './doctor-schedule.schema.js';

export interface DoctorLeaveRecord {
  id: string;
  date: string;
  reason?: string;
  createdAt: string;
}

export interface DoctorScheduleData {
  timezone: string;
  activeDays: number[];
  startHour: number;
  endHour: number;
  slotDurationMinutes: number;
  breakStart: string | null;
  breakEnd: string | null;
  leaves: DoctorLeaveRecord[];
}

const DEFAULT_SCHEDULE: Omit<DoctorScheduleData, 'leaves'> = {
  timezone: 'Asia/Kolkata',
  activeDays: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 17,
  slotDurationMinutes: 30,
  breakStart: null,
  breakEnd: null,
};

@Injectable()
export class DoctorScheduleService {
  // In-memory persistent cache per doctor, providing instantaneous reads and resilient fallback
  private readonly schedules = new Map<string, DoctorScheduleData>();

  async getSchedule(doctorId: string): Promise<DoctorScheduleData> {
    const existing = this.schedules.get(doctorId);
    if (existing) {
      return existing;
    }
    const fresh: DoctorScheduleData = {
      ...DEFAULT_SCHEDULE,
      leaves: [],
    };
    this.schedules.set(doctorId, fresh);
    return fresh;
  }

  async updateSchedule(doctorId: string, update: DoctorScheduleUpdate): Promise<DoctorScheduleData> {
    const current = await this.getSchedule(doctorId);
    const updated: DoctorScheduleData = {
      ...current,
      timezone: update.timezone,
      activeDays: [...update.activeDays].sort((a, b) => a - b),
      startHour: update.startHour,
      endHour: update.endHour,
      slotDurationMinutes: update.slotDurationMinutes,
      breakStart: update.breakStart ?? null,
      breakEnd: update.breakEnd ?? null,
    };
    this.schedules.set(doctorId, updated);
    return updated;
  }

  async addLeave(doctorId: string, input: DoctorLeaveInput): Promise<DoctorLeaveRecord> {
    const schedule = await this.getSchedule(doctorId);
    const existingIndex = schedule.leaves.findIndex((l) => l.date === input.date);
    const record: DoctorLeaveRecord = {
      id: randomUUID(),
      date: input.date,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    if (existingIndex >= 0) {
      schedule.leaves[existingIndex] = record;
    } else {
      schedule.leaves.push(record);
      schedule.leaves.sort((a, b) => a.date.localeCompare(b.date));
    }
    this.schedules.set(doctorId, schedule);
    return record;
  }

  async removeLeave(doctorId: string, leaveId: string): Promise<void> {
    const schedule = await this.getSchedule(doctorId);
    const prevLen = schedule.leaves.length;
    schedule.leaves = schedule.leaves.filter((l) => l.id !== leaveId && l.date !== leaveId);
    if (schedule.leaves.length === prevLen) {
      throw new NotFoundException('Leave record not found.');
    }
    this.schedules.set(doctorId, schedule);
  }

  async checkConflicts(doctorId: string, newConfig: DoctorScheduleUpdate) {
    const now = new Date();
    // Query scheduled future appointments for this doctor
    const upcoming = await db.select({
      id: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
    }).from(appointment)
      .where(and(eq(appointment.doctorId, doctorId), eq(appointment.status, 'scheduled'), gte(appointment.startsAt, now)));

    const conflicts: Array<{ id: string; startsAt: Date; reason: string }> = [];

    for (const appt of upcoming) {
      const dayOfWeek = appt.startsAt.getUTCDay();
      if (!newConfig.activeDays.includes(dayOfWeek)) {
        conflicts.push({
          id: appt.id,
          startsAt: appt.startsAt,
          reason: `Appointment is on a day (${dayOfWeek}) removed from active schedule.`,
        });
        continue;
      }
      const hour = appt.startsAt.getUTCHours();
      if (hour < newConfig.startHour || hour >= newConfig.endHour) {
        conflicts.push({
          id: appt.id,
          startsAt: appt.startsAt,
          reason: `Appointment start (${hour}:00 UTC) falls outside new working hours (${newConfig.startHour}:00 - ${newConfig.endHour}:00).`,
        });
        continue;
      }
      if (newConfig.breakStart && newConfig.breakEnd) {
        const [bsh, bsm] = newConfig.breakStart.split(':').map(Number);
        const [beh, bem] = newConfig.breakEnd.split(':').map(Number);
        const breakStartMs = (bsh * 60 + bsm) * 60_000;
        const breakEndMs = (beh * 60 + bem) * 60_000;
        const apptStartMs = (hour * 60 + appt.startsAt.getUTCMinutes()) * 60_000;
        const apptEndMs = (appt.endsAt.getUTCHours() * 60 + appt.endsAt.getUTCMinutes()) * 60_000;

        if (apptStartMs < breakEndMs && apptEndMs > breakStartMs) {
          conflicts.push({
            id: appt.id,
            startsAt: appt.startsAt,
            reason: `Appointment overlaps with new break window (${newConfig.breakStart} - ${newConfig.breakEnd}).`,
          });
        }
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflictCount: conflicts.length,
      conflicts,
    };
  }

  async getScheduleConfigForProfile(doctorProfileId: string): Promise<DoctorScheduleConfig> {
    const [doc] = await db.select({ userId: doctorProfile.userId })
      .from(doctorProfile)
      .where(eq(doctorProfile.id, doctorProfileId))
      .limit(1);

    if (!doc) {
      return {};
    }

    const schedule = await this.getSchedule(doc.userId);
    return {
      timezone: schedule.timezone,
      activeDays: schedule.activeDays,
      startHour: schedule.startHour,
      endHour: schedule.endHour,
      slotDurationMinutes: schedule.slotDurationMinutes,
      breakStart: schedule.breakStart,
      breakEnd: schedule.breakEnd,
      leaveDates: schedule.leaves.map((l) => l.date),
    };
  }
}
