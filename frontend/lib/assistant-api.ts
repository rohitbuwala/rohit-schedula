import { z } from "zod";

export const assistantMessageSchema = z.string().trim().min(1).max(1000);

const slot = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
}).refine(({ startsAt, endsAt }) => Date.parse(startsAt) < Date.parse(endsAt));
const appointmentStatus = z.enum(["pending_payment", "scheduled", "completed", "cancelled"]);
const appointment = slot.safeExtend({ id: z.uuid(), status: appointmentStatus });
const doctor = z.object({
  id: z.uuid(),
  name: z.string(),
  specialty: z.string(),
});
const reply = z.string();
const hasMore = z.boolean();
const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: value === "IST" ? "Asia/Kolkata" : value });
    return true;
  } catch {
    return false;
  }
});
const hour = z.number().int().min(0).max(24);
const breakTime = z.string().regex(/^\d{2}:\d{2}$/).nullable();
const count = z.number().int().nonnegative();
const appointmentPeriod = z.enum(["upcoming", "past"]);
const availabilityFields = { doctorProfileId: z.uuid(), date: z.iso.date(), timezone, durationMinutes: z.number().positive() };
export type PatientAppointmentFilter = "upcoming" | "past" | "all";
export const cancellationReasons = {
  schedule_conflict: "Schedule conflict",
  no_longer_needed: "Appointment no longer needed",
  other: "Other",
} as const;
export type CancellationReason = keyof typeof cancellationReasons;

export const bookingPrefillSchema = z.object({
  doctorProfileId: z.string().uuid().optional(),
  doctorName: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  specialty: z.string().optional(),
}).nullable();

export const assistantResponseSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("clarify"), reply, data: z.null() }),
  z.object({ tool: z.literal("start_booking"), reply, data: bookingPrefillSchema }),
  z.object({ tool: z.literal("payment_history"), reply, data: z.object({
    payments: z.array(z.object({
      appointmentStartsAt: z.iso.datetime({ offset: true }), doctorName: z.string(),
      amountPaise: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/),
      paymentStatus: z.enum(["created", "captured", "failed", "refunded"]),
      refundStatus: z.enum(["pending", "processed", "failed"]).nullable(),
    })).max(50),
    hasMore,
  }) }),
  z.object({ tool: z.literal("list_prescriptions"), reply, data: z.object({
    prescriptions: z.array(z.object({
      issuedAt: z.iso.datetime({ offset: true }), doctorName: z.string(),
      medications: z.array(z.object({ name: z.string(), instructions: z.string() })),
    })).max(50),
    hasMore,
  }) }),
  z.object({ tool: z.literal("list_appointments"), reply, data: z.object({
    filter: z.enum(["upcoming", "past", "all", "cancellable", "reschedulable"]),
    appointments: z.array(appointment.safeExtend({ doctor, period: appointmentPeriod })).max(50), hasMore,
  }) }),
  z.object({ tool: z.literal("search_doctors"), reply, data: z.object({
    doctors: z.array(doctor.extend({ consultationFeeInr: z.number().nonnegative().nullable() })).max(20), hasMore,
  }) }),
  z.object({ tool: z.literal("check_availability"), reply, data: z.object({
    ...availabilityFields, slots: z.array(slot),
  }) }),
  z.object({ tool: z.literal("alternative_slots"), reply, data: z.object({
    ...availabilityFields, slots: z.array(slot).max(3),
  }) }),
  z.object({ tool: z.literal("today_appointments"), reply, data: z.object({
    date: z.iso.date(), timezone, appointments: z.array(appointment).max(50), hasMore,
  }) }),
  z.object({ tool: z.literal("doctor_appointments_by_date"), reply, data: z.object({
    date: z.iso.date(), timezone, appointments: z.array(slot.safeExtend({ status: appointmentStatus })).max(50), hasMore,
  }) }),
  z.object({ tool: z.literal("next_available_slot"), reply, data: z.object({
    timezone, horizonDays: z.number().int().min(1).max(90), slot: slot.nullable(),
  }) }),
  z.object({ tool: z.literal("reschedule_suggestions"), reply, data: z.object({
    timezone, slots: z.array(slot).max(3),
  }) }),
  z.object({ tool: z.literal("appointment_statistics"), reply, data: z.object({
    date: z.iso.date(), timezone, total: count,
    byStatus: z.object({ pending_payment: count, scheduled: count, completed: count, cancelled: count }),
  }) }),
  z.object({ tool: z.literal("schedule_conflicts"), reply, data: slot.safeExtend({
    timezone, conflicts: z.array(slot.safeExtend({ id: z.uuid() })).max(50), hasMore,
  }) }),
  z.object({ tool: z.literal("appointment_details"), reply, data: appointment.safeExtend({ timezone }) }),
  z.object({ tool: z.literal("view_schedule"), reply, data: z.object({
    timezone, activeDays: z.array(z.number().int().min(0).max(6)), startHour: hour, endHour: hour,
    slotDurationMinutes: z.number().positive(), breakStart: breakTime, breakEnd: breakTime,
    leaveDates: z.array(z.iso.date()),
  }) }),
]);

export type AssistantResponse = z.infer<typeof assistantResponseSchema>;

const messages: Readonly<Record<number, string>> = {
  400: "Enter a message between 1 and 1,000 characters.",
  401: "Your session has expired. Sign in again to continue.",
  403: "Your account does not have access to the assistant.",
  404: "That appointment or doctor could not be found.",
  409: "Alternative slots are available only for scheduled appointments.",
  429: "The assistant request limit was reached. Wait a moment and try again.",
  503: "The assistant is temporarily unavailable. Try again shortly.",
};

export class AssistantApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AssistantApiError";
    this.status = status;
  }
}

export async function transcribeAssistantAudio(audio: Blob, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", audio, "recording.wav");
  const response = await fetch("/api/assistant/voice/transcribe", {
    method: "POST", credentials: "include", cache: "no-store", body: form, signal,
  });
  if (!response.ok) throw new AssistantApiError(messages[response.status] ?? "Voice transcription is unavailable. Try again.", response.status);
  const body: unknown = await response.json().catch(() => { signal?.throwIfAborted(); return null; });
  const result = z.object({ transcript: z.string().max(1000) }).safeParse(body);
  if (!result.success) throw new AssistantApiError("Voice transcription returned an unexpected response.");
  return result.data.transcript.trim();
}

export async function synthesizeAssistantAudio(text: string, language: "en" | "hi", signal?: AbortSignal): Promise<Blob> {
  const response = await fetch("/api/assistant/voice/synthesize", {
    method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, language }),
  });
  if (!response.ok) throw new AssistantApiError(messages[response.status] ?? "Voice output is unavailable. Try again.", response.status);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio/wav")) throw new AssistantApiError("Voice output returned an unexpected response.");
  const audio = await response.blob();
  signal?.throwIfAborted();
  if (!audio.size || audio.size > 8 * 1024 * 1024) throw new AssistantApiError("Voice output returned an unexpected response.");
  return audio;
}

const rescheduleOptionsSchema = z.object({
  currentStartsAt: z.iso.datetime({ offset: true }), timezone, slots: z.array(slot).max(3),
});
export type RescheduleOptions = z.infer<typeof rescheduleOptionsSchema>;
export type RescheduleSlot = z.infer<typeof slot>;

async function readRescheduleResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    throw new AssistantApiError(response.status === 409
      ? "This appointment or slot is no longer available. Review the appointment again."
      : messages[response.status] ?? "Could not complete the reschedule request.", response.status);
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AssistantApiError("The assistant returned an unexpected response.");
  return parsed.data;
}

export async function getAssistantRescheduleOptions(appointmentId: string) {
  const id = z.uuid().parse(appointmentId);
  const response = await fetch(`/api/assistant/appointments/${id}/reschedule-options`, { credentials: "include", cache: "no-store" });
  return readRescheduleResponse(response, rescheduleOptionsSchema);
}

export async function confirmAssistantReschedule(appointmentId: string, expectedStartsAt: string, selected: RescheduleSlot) {
  const response = await fetch("/api/assistant/appointments/reschedule", {
    method: "PATCH", credentials: "include", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId, expectedStartsAt, slot: selected, confirmed: true }),
  });
  return readRescheduleResponse(response, slot);
}

export async function confirmAssistantCancellation(appointmentId: string, reason: CancellationReason) {
  if (!z.uuid().safeParse(appointmentId).success || !Object.hasOwn(cancellationReasons, reason)) {
    throw new AssistantApiError("Select an appointment and cancellation reason.", 400);
  }
  const response = await fetch("/api/assistant/appointments/cancel", {
    method: "PATCH", credentials: "include", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId, reason, confirmed: true }),
  });
  if (!response.ok) {
    const message = response.status === 409 ? "This appointment is no longer eligible for cancellation."
      : [401, 403, 404].includes(response.status) ? messages[response.status]
      : "Cancellation could not be confirmed. Check your appointment status before trying again.";
    throw new AssistantApiError(message, response.status);
  }
  const result = await response.json().catch(() => null);
  if (result?.status !== "cancelled") {
    throw new AssistantApiError("Cancellation could not be confirmed. Check your appointment status.");
  }
}

export async function sendAssistantMessage(message: string, signal?: AbortSignal): Promise<AssistantResponse> {
  const input = assistantMessageSchema.safeParse(message);
  if (!input.success) throw new AssistantApiError(messages[400], 400);
  const response = await fetch("/api/assistant/chat", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: input.data }),
    signal,
  });
  if (!response.ok) {
    throw new AssistantApiError(messages[response.status] ?? "The assistant could not respond. Try again.", response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    signal?.throwIfAborted();
    throw new AssistantApiError("The assistant returned an unexpected response. Try again.");
  }
  const result = assistantResponseSchema.safeParse(body);
  if (!result.success) throw new AssistantApiError("The assistant returned an unexpected response. Try again.");
  return result.data;
}
