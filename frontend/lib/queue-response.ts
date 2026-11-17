import { z } from "zod";

const instant = z.iso.datetime({ offset: true });
const timezone = z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
export const attendanceSchema = z.object({
  appointmentId: z.uuid(), status: z.enum(["not_checked_in", "waiting", "in_service", "completed", "cancelled", "no_show"]),
  tokenNumber: z.number().int().positive().nullable(), position: z.number().int().positive().nullable(),
  checkedInAt: instant.nullable(), startedAt: instant.nullable(), serviceDate: z.iso.date().nullable(),
  timezone: timezone.nullable(), version: z.number().int().positive().nullable(), queueVersion: z.number().int().nonnegative(),
});
export const ownAttendanceSchema = z.object({ appointments: z.array(attendanceSchema) });
const booked = z.object({ appointmentId: z.uuid(), patientName: z.string(), startsAt: instant, endsAt: instant });
export const queueResponseSchema = z.object({
  doctorId: z.string().min(1), serviceDate: z.iso.date(), timezone, version: z.number().int().nonnegative(),
  current: booked.extend({ tokenNumber: z.number().int().positive(), checkedInAt: instant, startedAt: instant,
    serviceDate: z.iso.date(), timezone, status: z.literal("in_service") }).nullable(),
  waiting: z.array(booked.extend({ tokenNumber: z.number().int().positive(), checkedInAt: instant,
    position: z.number().int().positive(), status: z.literal("waiting") })),
  expected: z.array(booked), waitingCount: z.number().int().nonnegative(),
  closed: z.array(booked.extend({ tokenNumber: z.number().int().positive().nullable(),
    status: z.enum(["completed", "cancelled", "no_show"]), terminalAt: instant })).default([]),
  hasMoreWaiting: z.boolean(), hasMoreExpected: z.boolean(), nextCursor: z.string().nullable(),
});
export const queueAssignmentsSchema = z.array(z.object({ doctorId: z.string().min(1), name: z.string() }));
export type Attendance = z.infer<typeof attendanceSchema>;
export type DailyQueue = z.infer<typeof queueResponseSchema>;

export function localQueueDate(now: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function queueTimeRange(startsAt: string, endsAt: string, zone: string) {
  const format = new Intl.DateTimeFormat("en-IN", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  return `${format.format(new Date(startsAt))} – ${format.format(new Date(endsAt))}`;
}
type BookingStatus = "scheduled" | "pending_payment" | "completed" | "cancelled";
export function visitStatus(bookingStatus: BookingStatus, attendance?: Attendance) {
  if (bookingStatus !== "scheduled") return bookingStatus;
  return attendance && (attendance.status === "no_show" || attendance.status === "completed" || attendance.status === "cancelled") ? attendance.status : bookingStatus;
}
export function isUpcomingVisit(booking: { status: BookingStatus; endsAt: string }, attendance: Attendance | undefined, now: number) {
  return visitStatus(booking.status, attendance) === "scheduled" &&
    (attendance?.status === "waiting" || attendance?.status === "in_service" || Date.parse(booking.endsAt) > now);
}
export function attendanceLabel(status: Attendance["status"]) {
  return { not_checked_in: "Not checked in", waiting: "Checked in · Waiting", in_service: "With your doctor",
    completed: "Consultation completed", cancelled: "Cancelled", no_show: "Marked absent" }[status];
}
