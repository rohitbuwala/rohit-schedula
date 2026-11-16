export type BookingDoctor = { id: string; name: string; specialty: string; consultationFeeInr: number | null };
export type BookingSlot = { startsAt: string; endsAt: string };
export type BookingDraft = { doctor: BookingDoctor | null; date: string; slot: BookingSlot | null; timezone: string; fee: number | null };
export type BookingAttempt = { key: string; payload: { doctorProfileId: string; startsAt: string; endsAt: string } };
export type HoldResult = { id: string; status: string; startsAt: string; endsAt: string; holdExpiresAt: string | null };

// A known booking result is a receipt, not an unfinished conversational draft.
// Keep its controls visible without intercepting subsequent assistant questions.
export function hasUnfinishedBookingDraft(active: boolean, result: HoldResult | null, message = ""): boolean {
  const lookup = /\b(?:my|our)\s+(?:(?:upcoming|past|previous|confirmed|all)\s+)?(?:bookings?|appointments?)\b/i.test(message);
  const action = /\b(?:book|reserve|schedule|cancel|reschedule|change|pay|confirm|delete|remove)\b/i.test(message);
  if (lookup && !action) return false;
  return active && result === null;
}

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export function bookingStorageKey(patientId: string) { return `medrella.booking-attempt.v1:${patientId}`; }

export function readBookingAttempt(storage: Pick<Storage, "getItem">, patientId: string):
  { kind: "missing" | "invalid" | "unavailable" } | { kind: "found"; attempt: BookingAttempt } {
  try {
    const raw = storage.getItem(bookingStorageKey(patientId));
    if (raw === null) return { kind: "missing" };
    if (raw.length > 2048) return { kind: "invalid" };
    const value = JSON.parse(raw);
    const attempt = value?.attempt;
    const payload = attempt?.payload;
    if (value?.version !== 1 || value?.patientId !== patientId || typeof attempt?.key !== "string" || !uuid.test(attempt.key) ||
        typeof payload?.doctorProfileId !== "string" || !uuid.test(payload.doctorProfileId) || typeof payload?.startsAt !== "string" || typeof payload?.endsAt !== "string" ||
        !Number.isFinite(Date.parse(payload.startsAt)) || !Number.isFinite(Date.parse(payload.endsAt)) || Date.parse(payload.endsAt) <= Date.parse(payload.startsAt)) return { kind: "invalid" };
    return { kind: "found", attempt: { key: attempt.key, payload: { doctorProfileId: payload.doctorProfileId, startsAt: payload.startsAt, endsAt: payload.endsAt } } };
  } catch { return { kind: "unavailable" }; }
}

export function saveBookingAttempt(storage: Pick<Storage, "setItem" | "getItem">, patientId: string, attempt: BookingAttempt) {
  try {
    const serialized = JSON.stringify({ version: 1, patientId, attempt });
    storage.setItem(bookingStorageKey(patientId), serialized);
    return storage.getItem(bookingStorageKey(patientId)) === serialized;
  } catch { return false; }
}

export function clearBookingAttempt(storage: Pick<Storage, "removeItem">, patientId: string) {
  try { storage.removeItem(bookingStorageKey(patientId)); return true; } catch { return false; }
}

export async function createBookingHold(attempt: BookingAttempt, request: typeof fetch = fetch, patientId?: string): Promise<
  | { kind: "result"; hold: HoldResult }
  | { kind: "conflict" | "key_conflict" | "uncertain" | "rejected" }
> {
  try {
    const response = await request("/api/appointments", { method: "POST", credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key, ...(patientId ? { "X-Booking-Patient": patientId } : {}) }, body: JSON.stringify(attempt.payload) });
    if (response.status === 409) {
      const body = await response.json().catch(() => null);
      if (body?.message === "Idempotency key was used for a different booking.") return { kind: "key_conflict" };
      if (["The selected doctor already has a scheduled appointment in that time slot.", "The doctor is already booked for that time."].includes(body?.message)) return { kind: "conflict" };
      return { kind: "uncertain" };
    }
    if (!response.ok) return { kind: response.status >= 500 ? "uncertain" : "rejected" };
    const hold = await response.json();
    if (typeof hold?.id !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(hold.id) ||
        !["pending_payment", "scheduled", "cancelled", "completed"].includes(hold.status) ||
        typeof hold.startsAt !== "string" || typeof hold.endsAt !== "string" ||
        !Number.isFinite(Date.parse(hold.startsAt)) || !Number.isFinite(Date.parse(hold.endsAt)) ||
        Date.parse(hold.startsAt) !== Date.parse(attempt.payload.startsAt) || Date.parse(hold.endsAt) !== Date.parse(attempt.payload.endsAt) ||
        (hold.holdExpiresAt !== null && (typeof hold.holdExpiresAt !== "string" || !Number.isFinite(Date.parse(hold.holdExpiresAt))))) return { kind: "uncertain" };
    return { kind: "result", hold };
  } catch { return { kind: "uncertain" }; }
}

export function emptyBookingDraft(): BookingDraft {
  return { doctor: null, date: "", slot: null, timezone: "Asia/Kolkata", fee: null };
}

export function matchDoctor(message: string, doctors: BookingDoctor[]) {
  const needle = message.trim().toLowerCase().replace(/^dr\.?\s+/, "");
  if (!needle) return null;
  const matches = doctors.filter((doctor) => doctor.name.toLowerCase().replace(/^dr\.?\s+/, "").includes(needle));
  return matches.length === 1 ? matches[0] : null;
}

export function parseBookingDate(message: string, timezone: string, now = new Date()) {
  const text = message.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
  }
  if (text !== "today" && text !== "tomorrow") return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const date = new Date(`${today}T00:00:00Z`);
  if (text === "tomorrow") date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function matchSlot(message: string, slots: BookingSlot[], timezone: string) {
  const text = message.trim().toLowerCase();
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match || (!match[2] && !match[3])) return null;
  let hour = Number(match[1]); const minute = Number(match[2] ?? 0);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (match[3]) hour = hour % 12 + (match[3] === "pm" ? 12 : 0);
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const target = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const matches = slots.filter((slot) => formatter.format(new Date(slot.startsAt)) === target);
  return matches.length === 1 ? matches[0] : null;
}
