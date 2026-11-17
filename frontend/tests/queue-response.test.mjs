import assert from "node:assert/strict";
import { it } from "node:test";
import { attendanceSchema, queueResponseSchema, ownAttendanceSchema } from "../lib/queue-response.ts";

const id = "00000000-0000-4000-8000-000000000001";
const visit = { appointmentId: id, status: "waiting", tokenNumber: 8, position: 2, checkedInAt: "2026-11-16T04:00:00Z", startedAt: null, serviceDate: "2026-11-16", timezone: "Asia/Kolkata", version: 1, queueVersion: 8 };
it("validates attendance and strips fields that do not belong in a patient summary", () => {
  const parsed = attendanceSchema.parse({ ...visit, patientName: "Other patient", checkedInBy: "staff", payment: { amount: 100 } });
  assert.deepEqual(parsed, visit);
  assert.equal(ownAttendanceSchema.safeParse({ appointments: [{ ...visit, position: -1 }] }).success, false);
  assert.equal(attendanceSchema.safeParse({ ...visit, timezone: "invalid-zone" }).success, false);
});
it("keeps own and serving tokens separate and accepts saved consultation completion", () => {
  const parsed = attendanceSchema.parse({ ...visit, currentTokenNumber: 3, completedAt: null, patientName: "Private" });
  assert.equal(parsed.tokenNumber, 8);
  assert.equal(parsed.currentTokenNumber, 3);
  assert.equal("patientName" in parsed, false);
  assert.equal(attendanceSchema.safeParse({ ...visit, currentTokenNumber: 0 }).success, false);
  assert.equal(attendanceSchema.safeParse({ ...visit, completedAt: "invalid" }).success, false);
});
it("parses a scoped daily queue with distinct current, waiting, expected and closed entries", () => {
  const booked = { appointmentId: id, patientName: "Test patient", startsAt: "2026-11-16T04:30:00Z", endsAt: "2026-11-16T04:45:00Z" };
  const queue = { doctorId: "doctor", serviceDate: "2026-11-16", timezone: "Asia/Kolkata", version: 8, current: null,
    waiting: [{ ...booked, status: "waiting", tokenNumber: 8, checkedInAt: visit.checkedInAt, position: 2 }], expected: [],
    closed: [{ ...booked, status: "no_show", tokenNumber: null, terminalAt: visit.checkedInAt }], waitingCount: 2, hasMoreWaiting: false, hasMoreExpected: false, nextCursor: null };
  assert.equal(queueResponseSchema.parse(queue).closed[0].status, "no_show");
  assert.equal(queueResponseSchema.safeParse({ ...queue, waiting: [{ ...queue.waiting[0], patientName: undefined }] }).success, false);
  assert.equal(queueResponseSchema.safeParse({ ...queue, version: -1 }).success, false);
});
