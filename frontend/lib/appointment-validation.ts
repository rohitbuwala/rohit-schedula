import { z } from "zod";

export const bookingSelectionSchema = z.object({
  doctorProfileId: z.uuid(),
  date: z.iso.date().optional(),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).optional(),
}).refine(({ date, startsAt, endsAt }) =>
  (!date && !startsAt && !endsAt) ||
  Boolean(date && startsAt && endsAt && Date.parse(startsAt) < Date.parse(endsAt)),
);

export type BookingSelection = z.infer<typeof bookingSelectionSchema>;

const recoveredHoldSchema = z.object({ id: z.uuid(), doctorProfileId: z.uuid(), doctorName: z.string(), specialty: z.string(),
  startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }),
  holdExpiresAt: z.iso.datetime({ offset: true }), status: z.literal("pending_payment"), consultationFeeInr: z.number().int().nonnegative().nullable() });

export function bookingHoldUrl(id: string) {
  return `/patient/book-appointment?${new URLSearchParams({ holdId: id })}`;
}

export function isBookingHoldExpired(expiry: string, now = Date.now()) {
  const deadline = Date.parse(expiry);
  return !Number.isFinite(deadline) || deadline <= now;
}

export async function recoverBookingHold(id: string, request: typeof fetch = fetch, now?: number) {
  if (!z.uuid().safeParse(id).success) return { kind: "unavailable" as const };
  try {
    const response = await request(`/api/appointments/${id}/hold`, { credentials: "include", cache: "no-store" });
    if (response.status === 404) {
      const detail = await request(`/api/appointments/${id}`, { credentials: "include", cache: "no-store" });
      if (detail.ok) {
        const result = z.object({ id: z.uuid(), status: z.string() }).safeParse(await detail.json());
        if (result.success && result.data.id === id && result.data.status === "scheduled") return { kind: "scheduled" as const };
      }
      return { kind: "unavailable" as const };
    }
    if (!response.ok) return { kind: "unavailable" as const };
    const parsed = recoveredHoldSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.id !== id || Date.parse(parsed.data.holdExpiresAt) <= (now ?? Date.now()) || Date.parse(parsed.data.endsAt) <= Date.parse(parsed.data.startsAt)) return { kind: "unavailable" as const };
    return { kind: "hold" as const, hold: parsed.data };
  } catch { return { kind: "unavailable" as const }; }
}

export function bookingReviewUrl(selection: BookingSelection) {
  const query = new URLSearchParams({ doctorProfileId: selection.doctorProfileId });
  if (selection.date && selection.startsAt && selection.endsAt) {
    query.set("date", selection.date);
    query.set("startsAt", selection.startsAt);
    query.set("endsAt", selection.endsAt);
  }
  return `/patient/book-appointment?${query}#booking-form`;
}

export function matchBookingSelection<T extends { startsAt: string; endsAt: string }>(
  selection: BookingSelection, availability: { doctorProfileId: string; date: string; slots: T[] },
) {
  if (selection.doctorProfileId !== availability.doctorProfileId || selection.date !== availability.date) return null;
  return availability.slots.find(({ startsAt, endsAt }) =>
    startsAt === selection.startsAt && endsAt === selection.endsAt,
  ) ?? null;
}

export const appointmentFormSchema = z.object({
  doctorProfileId: z.uuid("Choose an approved doctor."),
  startsAt: z.string().min(1, "Choose a start date and time."),
  endsAt: z.string().min(1, "Choose an end date and time."),
}).superRefine(({ startsAt, endsAt }, context) => {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(start) || start <= Date.now()) {
    context.addIssue({ code: "custom", path: ["startsAt"], message: "Choose a future start time." });
  }
  if (!Number.isFinite(end) || end <= start) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "End time must be after the start time." });
  }
});
