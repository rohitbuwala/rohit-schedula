import assert from "node:assert/strict";
import { it } from "node:test";
import { cancelQueueAppointment, checkInPatient, completeQueueConsultation, readDailyQueue, readOwnAttendance, startNextPatient, QueueApiError } from "../lib/queue-api.ts";
const id = "00000000-0000-4000-8000-000000000001";
const summary = appointmentId => ({ appointmentId, status: "not_checked_in", tokenNumber: null, position: null, checkedInAt: null,
  startedAt: null, serviceDate: null, timezone: null, version: null, queueVersion: 0 });
it("batches patient attendance by 50, uses the authenticated session and forwards no patient identity", async () => {
  const ids = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const calls = [];
  const result = await readOwnAttendance(ids, undefined, async (url, options) => {
    calls.push({ url, options });
    const batch = new URL(url, "http://fixture").searchParams.get("appointmentIds").split(",");
    return Response.json({ appointments: batch.map(summary) });
  });
  assert.equal(calls.length, 2); assert.equal(Object.keys(result).length, 51);
  for (const call of calls) { assert.equal(call.options.credentials, "include"); assert.equal(call.options.cache, "no-store"); assert.doesNotMatch(call.url, /patientId/); }
});
it("rejects foreign, missing or duplicated attendance instead of guessing status", async () => {
  for (const appointments of [[], [summary(id), summary(id)], [summary("00000000-0000-4000-8000-999999999999")]]) {
    await assert.rejects(readOwnAttendance([id], undefined, async () => Response.json({ appointments })), QueueApiError);
  }
});
it("sends no token or actor on check-in and sends the observed version when starting", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, options }); return Response.json(summary(id)); });
  await checkInPatient(id); await startNextPatient("doctor", "2026-11-16", 7);
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.deepEqual(JSON.parse(calls[1].options.body), { serviceDate: "2026-11-16", expectedQueueVersion: 7 });
});
it("rejects mismatched queue scopes and explains stale versions, expired sessions and missing no-show configuration", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 401 }));
  await assert.rejects(checkInPatient(id), /session expired/);
  globalThis.fetch = async () => Response.json({ code: "QUEUE_NO_SHOW_NOT_CONFIGURED" }, { status: 503 });
  await assert.rejects(checkInPatient(id), /grace period/);
  globalThis.fetch = async () => Response.json({ code: "QUEUE_VERSION_CHANGED" }, { status: 409 });
  await assert.rejects(checkInPatient(id), error => error.status === 409 && error.code === "QUEUE_VERSION_CHANGED");
  globalThis.fetch = async () => Response.json({ doctorId: "other", serviceDate: "2026-11-16", timezone: "UTC", version: 0,
    current: null, waiting: [], expected: [], waitingCount: 0, hasMoreWaiting: false, hasMoreExpected: false, nextCursor: null });
  await assert.rejects(readDailyQueue("doctor", "2026-11-16"), /did not match/);
});
it("reuses the existing PATCH completion and cancellation contracts", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, options }); return Response.json({}); });
  await completeQueueConsultation(id); await cancelQueueAppointment(id);
  assert.match(calls[0].url, /\/complete$/); assert.match(calls[1].url, /\/cancel$/);
  for (const call of calls) { assert.equal(call.options.method, "PATCH"); assert.equal(call.options.credentials, "include"); }
});
