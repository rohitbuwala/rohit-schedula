import { attendanceSchema, ownAttendanceSchema, queueAssignmentsSchema, queueResponseSchema, type Attendance } from "./queue-response.ts";
import type { z } from "zod";

export class QueueApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}
async function request<T>(path: string, schema: z.ZodType<T> | null, signal?: AbortSignal, body?: unknown, fetcher: typeof fetch = fetch, method?: "PATCH"): Promise<T> {
  const response = await fetcher(path, { method: method ?? (body === undefined ? "GET" : "POST"), credentials: "include", cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const code = typeof error?.code === "string" ? error.code : undefined;
    const message = response.status === 401 ? "Your session expired. Please log in again."
      : response.status === 403 ? "You do not have access to this queue."
        : response.status === 404 ? "This appointment or assigned queue is no longer available."
          : code === "QUEUE_NO_SHOW_NOT_CONFIGURED" ? "No-show is unavailable until the clinic configures its grace period."
            : code === "QUEUE_NO_SHOW_TOO_EARLY" ? "The no-show grace period has not elapsed."
              : response.status === 409 ? "The appointment or queue changed. Refresh and review it before trying again."
                : "Queue information is temporarily unavailable. Please try again.";
    throw new QueueApiError(message, response.status, code);
  }
  if (!schema) return undefined as T;
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new QueueApiError("Queue information could not be verified. Please refresh.", 502);
  return parsed.data;
}
export const readQueueAssignments = (signal?: AbortSignal) => request("/api/queues/assignments", queueAssignmentsSchema, signal);
export async function readDailyQueue(doctorId: string, date: string, cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ doctorId, date, limit: "50", ...(cursor ? { cursor } : {}) });
  const result = await request(`/api/queues?${query}`, queueResponseSchema, signal);
  if (result.doctorId !== doctorId || result.serviceDate !== date) throw new QueueApiError("The queue response did not match your selection.", 502);
  return result;
}
export async function readOwnAttendance(ids: string[], signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const unique = [...new Set(ids)].sort();
  const result: Record<string, Attendance> = {};
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50);
    const response = await request(`/api/queues/mine?${new URLSearchParams({ appointmentIds: batch.join(",") })}`, ownAttendanceSchema, signal, undefined, fetcher);
    if (response.appointments.length !== batch.length || new Set(response.appointments.map(item => item.appointmentId)).size !== batch.length || response.appointments.some(item => !batch.includes(item.appointmentId))) {
      throw new QueueApiError("Attendance did not match your appointments. Please refresh.", 502);
    }
    for (const attendance of response.appointments) result[attendance.appointmentId] = attendance;
  }
  return result;
}
export const checkInPatient = (id: string, signal?: AbortSignal) => request(`/api/appointments/${encodeURIComponent(id)}/check-in`, attendanceSchema, signal, {});
export const startNextPatient = (doctorId: string, serviceDate: string, expectedQueueVersion: number, signal?: AbortSignal) =>
  request(`/api/queues/${encodeURIComponent(doctorId)}/next`, attendanceSchema, signal, { serviceDate, expectedQueueVersion });
export const markPatientAbsent = (id: string, signal?: AbortSignal) => request(`/api/appointments/${encodeURIComponent(id)}/no-show`, attendanceSchema, signal, { expectedAttendanceVersion: 0 });
export const completeQueueConsultation = (id: string, signal?: AbortSignal) => request(`/api/appointments/${encodeURIComponent(id)}/complete`, null, signal, {}, fetch, "PATCH");
export const cancelQueueAppointment = (id: string, signal?: AbortSignal) => request(`/api/appointments/${encodeURIComponent(id)}/cancel`, null, signal, {}, fetch, "PATCH");

// Single-flight polling, hidden-tab suspension and stale-response suppression.
export function createQueuePoller<T>(options: { load(signal: AbortSignal): Promise<T>; onData(data: T): void; onError(error: unknown): void;
  visibility: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">; interval?: number }) {
  let stopped = false, queued = false, active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  async function refresh() {
    clear();
    if (stopped || options.visibility.hidden) return;
    if (active) { queued = true; return; }
    const controller = new AbortController(); active = controller;
    try { const data = await options.load(controller.signal); if (!stopped && !controller.signal.aborted && active === controller) options.onData(data); }
    catch (error) { if (!stopped && !controller.signal.aborted && active === controller) options.onError(error); }
    finally {
      if (active === controller) {
        active = null;
        if (queued) { queued = false; void refresh(); }
        else if (!stopped && !options.visibility.hidden) timer = setTimeout(() => void refresh(), options.interval ?? 10000);
      }
    }
  }
  function visibilityChanged() {
    if (options.visibility.hidden) { clear(); active?.abort(); active = null; queued = false; }
    else void refresh();
  }
  options.visibility.addEventListener("visibilitychange", visibilityChanged);
  void refresh();
  return { refresh: () => void refresh(), stop() { stopped = true; clear(); active?.abort(); active = null; options.visibility.removeEventListener("visibilitychange", visibilityChanged); } };
}
