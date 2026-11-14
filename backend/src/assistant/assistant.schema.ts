import { z } from 'zod';
import { appointmentRescheduleSchema } from '../appointments/appointment-reschedule.schema.js';

export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(1000),
}).strict();

export const assistantCancellationSchema = z.object({
  appointmentId: z.uuid(),
  reason: z.enum(['schedule_conflict', 'no_longer_needed', 'other']),
  confirmed: z.literal(true),
}).strict();

export type AssistantCancellationReason = z.infer<typeof assistantCancellationSchema>['reason'];

export const assistantRescheduleSchema = z.object({
  appointmentId: z.uuid(),
  expectedStartsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  slot: appointmentRescheduleSchema,
  confirmed: z.literal(true),
}).strict();

const patientTools = {
  list_appointments: "List the patient's own upcoming, past, cancellable, or all appointments.",
  search_doctors: 'Find approved doctors by name or specialty.',
  check_availability: 'Check open slots with a doctor on a date.',
  alternative_slots: 'Suggest nearby open slots for a requested doctor, date, and unavailable time.',
};

const doctorTools = {
  reschedule_suggestions: "Suggest alternative available slots for a selected appointment without changing it.",
  next_available_slot: "Find the doctor's earliest available appointment slot within a search horizon.",
  today_appointments: "List today's appointments with references for opening details. Never use for a different date.",
  doctor_appointments_by_date: "List the doctor's appointment times and statuses for today, tomorrow, or a specified date.",
  appointment_statistics: "Count the doctor's appointments by status for today or a requested date.",
  schedule_conflicts: "Check whether the doctor's scheduled appointments overlap a requested time range.",
  appointment_details: 'Show details of one appointment identified by an appointment reference.',
  view_schedule: "Show the doctor's working hours, breaks, slot duration, and planned leave.",
};

export type AssistantTool = keyof typeof patientTools | keyof typeof doctorTools | 'list_prescriptions' | 'payment_history';

export function allowedTools(role: 'patient' | 'doctor') {
  const tools = role === 'patient' ? patientTools : doctorTools;
  return {
    ...tools,
    clarify: 'Use for unsupported actions, unrelated requests, or ambiguous intent.',
  };
}

export const toolSelectionSchema = z.object({
  name: z.string().min(1),
  args: z.object({}).strict().optional(),
});
