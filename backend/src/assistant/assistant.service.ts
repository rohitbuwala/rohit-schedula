import {
  ForbiddenException, HttpException, HttpStatus, Inject, Injectable,
  InternalServerErrorException, Logger, ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import type { z } from 'zod';
import { DoctorProfilesService } from '../doctors/doctor-profiles.service.js';
import { ASSISTANT_PROVIDER, type AssistantProvider } from './assistant-provider.js';
import { allowedTools, toolSelectionSchema, type assistantRescheduleSchema, type AssistantCancellationReason, type AssistantTool } from './assistant.schema.js';
import { AssistantToolsService } from './assistant-tools.service.js';
import { detectBookingIntent, extractBookingDetails } from './booking-intent.js';

// Only these fixed scheduling terms can leave Medrella. Names, dates, IDs and
// other free text are resolved locally after tool selection.
const intentWords = new Set(
  'alternative alternatives appointment appointments available availability break breaks calendar conflict conflicts count counts daily date day detail details doctor doctors find free future history hour hours leave leaves list lookup my next open openings overlap overlapping overlaps past previous range rescheduling schedule search show slot slots specialist specialty statistics stats status suggest suggestion suggestions time today tomorrow total unavailable upcoming view working'.split(' '),
);
const writeRequest = /\b(?:add|book|cancel|change|complete|confirm|create|delete|mark|modify|move|pay|refund|remove|reschedule|reserve|set|update)\b/i;
const GEMINI_WINDOW_MS = 60_000;
const GEMINI_REQUEST_LIMIT = 10;
const GEMINI_PROCESS_CONCURRENCY_LIMIT = 8;

interface GeminiUsage {
  starts: number[];
  inFlight: boolean;
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly geminiUsage = new Map<string, GeminiUsage>();
  private nextUsageCleanup = 0;
  private inFlightProviderCalls = 0;

  constructor(
    @Inject(ASSISTANT_PROVIDER) private readonly provider: AssistantProvider,
    private readonly tools: AssistantToolsService,
    private readonly profiles: DoctorProfilesService,
  ) {}

  async chat(actor: AuthenticatedUser, message: string) {
    try {
      return await this.handleChat(actor, message);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Database errors can embed SQL parameters and nested causes.
      this.logger.error('Assistant request failed.');
      throw new InternalServerErrorException('Assistant request failed.');
    }
  }

  cancelAppointment(actor: AuthenticatedUser, appointmentId: string, reason: AssistantCancellationReason) {
    return this.runPatientAction(actor, () => this.tools.cancelAppointment(actor, appointmentId, reason));
  }

  rescheduleOptions(actor: AuthenticatedUser, id: string) {
    return this.runPatientAction(actor, () => this.tools.rescheduleOptions(actor, id));
  }

  rescheduleAppointment(actor: AuthenticatedUser, input: z.output<typeof assistantRescheduleSchema>) {
    return this.runPatientAction(actor, () => this.tools.rescheduleAppointment(actor, input));
  }

  private async runPatientAction<T>(actor: AuthenticatedUser, run: () => Promise<T>) {
    if (actor.role !== 'patient') throw new ForbiddenException();
    try {
      await this.assertEligible(actor);
      return await run();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('Assistant appointment action failed.');
      throw new InternalServerErrorException('Assistant appointment action failed.');
    }
  }

  private async handleChat(actor: AuthenticatedUser, message: string) {
    if (actor.role !== 'patient' && actor.role !== 'doctor') throw new ForbiddenException();
    await this.assertEligible(actor);

    const clarify = {
      tool: 'clarify',
      reply: actor.role === 'patient'
        ? 'I can show appointments, find a doctor, or check availability. To make changes, open Cancellable or Reschedulable appointments and review your selection.'
        : "I can show today's appointments, appointment details, appointment statistics, your schedule, schedule conflicts, or your next available slot.",
      data: null,
    };
    const actionText = actor.role === 'doctor' ? message.replace(/\breschedule(?=\s+suggestions?\b)/gi, '') : message;
    if (/^(?:(?:show|view|list)\s+(?:me\s+)?)?(?:my\s+)?(?:payment history|refund history|refund status)[.!?]?$/i.test(message)) {
      return actor.role === 'patient' ? this.tools.execute('payment_history', actor, message) : clarify;
    }
    if (actor.role === 'patient' && detectBookingIntent(message)) {
      const publicProfiles = (await this.profiles.listPublicProfiles()) ?? [];
      const extracted = extractBookingDetails(message, publicProfiles);

      let reply = 'Choose a doctor to start a booking draft.';
      if (extracted.doctorName && extracted.date && extracted.time) {
        reply = `I've started a booking draft with ${extracted.doctorName} for ${extracted.date} at ${extracted.time}. Please review the details.`;
      } else if (extracted.doctorName && extracted.date) {
        reply = `I've started a booking draft with ${extracted.doctorName} for ${extracted.date}. Choose an available time slot.`;
      } else if (extracted.doctorName) {
        reply = `I've started a booking draft with ${extracted.doctorName}. Choose a date to check availability.`;
      } else if (extracted.date) {
        reply = `I've started a booking draft for ${extracted.date}. Select a doctor to continue.`;
      } else if (extracted.specialty) {
        reply = `I've started a booking draft for ${extracted.specialty}. Select a doctor to continue.`;
      }

      return {
        tool: 'start_booking',
        reply,
        data: {
          doctorProfileId: extracted.doctorProfileId,
          doctorName: extracted.doctorName,
          date: extracted.date,
          time: extracted.time,
          specialty: extracted.specialty,
        },
      } as const;
    }
    if (writeRequest.test(actionText)) return clarify;
    if (actor.role === 'patient' && /\b(?:my|our)\s+(?:(?:upcoming|past|previous|confirmed|all)\s+)?bookings?\b/i.test(message)) {
      return this.tools.execute('list_appointments', actor, message);
    }
    if (actor.role === 'patient' && /\bprescriptions?\b/i.test(message)) {
      return this.tools.execute('list_prescriptions', actor, message);
    }
    if (actor.role === 'patient' && /\b(?:cancellable|reschedulable) appointments\b/i.test(message)) {
      return this.tools.execute('list_appointments', actor, message);
    }
    const words = message.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
    const intent = [...new Set(words.filter((word) => intentWords.has(word)))];
    if (actor.role === 'doctor' && /\b\d{4}-\d{2}-\d{2}\b/.test(message)) intent.push('date provided');
    if (actor.role === 'doctor' && /\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/i.test(message)) {
      intent.push('appointment reference provided');
    }
    if (!intent.length) return clarify;

    const tools = allowedTools(actor.role);
    const selection = toolSelectionSchema.safeParse(await this.selectTool(actor.id, intent.join(' '), tools));
    if (!selection.success || !Object.hasOwn(tools, selection.data.name)) {
      throw new ServiceUnavailableException('Assistant could not select a supported tool.');
    }
    if (selection.data.name === 'clarify') return clarify;
    await this.assertEligible(actor);
    return this.tools.execute(selection.data.name as AssistantTool, actor, message);
  }

  async assertEligible(actor: AuthenticatedUser) {
    if (actor.role !== 'doctor' && actor.role !== 'patient') throw new ForbiddenException();
    if (actor.role === 'doctor' && !(await this.profiles.isApproved(actor.id))) {
      throw new ForbiddenException();
    }
    if (actor.role === 'patient' &&
        (await this.profiles.getApplicationForApplicant(actor.id))?.status === 'pending') {
      throw new ForbiddenException();
    }
  }

  private async selectTool(userId: string, intent: string, tools: Readonly<Record<string, string>>) {
    const now = Date.now();
    const cutoff = now - GEMINI_WINDOW_MS;
    if (now >= this.nextUsageCleanup) {
      for (const [id, usage] of this.geminiUsage) {
        if (!usage.inFlight && usage.starts.every((start) => start <= cutoff)) {
          this.geminiUsage.delete(id);
        }
      }
      this.nextUsageCleanup = now + GEMINI_WINDOW_MS;
    }

    const usage = this.geminiUsage.get(userId) ?? { starts: [], inFlight: false };
    if (usage.inFlight) {
      throw new HttpException('A Gemini request is already in progress.', HttpStatus.TOO_MANY_REQUESTS);
    }
    usage.starts = usage.starts.filter((start) => start > cutoff);
    if (usage.starts.length >= GEMINI_REQUEST_LIMIT) {
      throw new HttpException('Assistant request limit reached. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (this.inFlightProviderCalls >= GEMINI_PROCESS_CONCURRENCY_LIMIT) {
      throw new ServiceUnavailableException('Assistant is busy. Try again shortly.');
    }

    usage.starts.push(now);
    usage.inFlight = true;
    this.geminiUsage.set(userId, usage);
    this.inFlightProviderCalls++;
    try {
      return await this.provider.selectTool(intent, tools);
    } finally {
      usage.inFlight = false;
      this.inFlightProviderCalls--;
    }
  }
}
