import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { createQueuePoller } from "../lib/queue-api.ts";
import { attendanceLabel, consultationDuration, isUpcomingVisit, localQueueDate, matchesQueueSearch, queueTimeRange, visitStatus } from "../lib/queue-response.ts";

it("finds an arrival by name or exact booking token without confusing it with position", () => {
  const patient = { patientName: "Rohit Kumar", tokenNumber: 12, position: 1 };
  assert.equal(matchesQueueSearch(patient, "  rohIT "), true);
  assert.equal(matchesQueueSearch(patient, "#12"), true);
  assert.equal(matchesQueueSearch(patient, "12"), true);
  assert.equal(matchesQueueSearch(patient, "1"), false);
  assert.equal(matchesQueueSearch({ patientName: "Test", tokenNumber: null }, "12"), false);
  assert.equal(matchesQueueSearch(patient, " "), true);
});

it("measures actual consultation time independently of the booked slot", () => {
  assert.equal(consultationDuration("2026-11-16T04:35:00Z", "2026-11-16T04:47:09Z"), "12 min 9 sec");
  assert.equal(consultationDuration("2026-11-16T04:35:00Z", Date.parse("2026-11-16T04:35:30Z")), "0 min 30 sec");
  assert.equal(consultationDuration("2026-11-16T04:35:00Z", "2026-11-16T04:34:00Z"), "Unavailable");
  assert.equal(consultationDuration("invalid", Date.now()), "Unavailable");
});

it("separates stable tokens from positions and keeps delayed active visits out of history", () => {
  const booking = Object.freeze({ status: "scheduled", endsAt: "2026-11-16T04:30:00Z", payment: { status: "captured" } });
  assert.equal(isUpcomingVisit(booking, { status: "waiting", tokenNumber: 8, position: 2 }, Date.parse("2026-11-16T06:00:00Z")), true);
  assert.equal(isUpcomingVisit(booking, { status: "in_service" }, Date.parse("2026-11-16T06:00:00Z")), true);
  assert.equal(isUpcomingVisit(booking, { status: "no_show" }, Date.parse("2026-11-16T04:00:00Z")), false);
  assert.equal(visitStatus(booking.status, { status: "completed" }), "completed");
  assert.equal(booking.payment.status, "captured");
  assert.equal(attendanceLabel("no_show"), "Marked absent");
});
it("uses the doctor's local date and actual appointment duration", () => {
  assert.equal(localQueueDate(new Date("2026-11-15T20:00:00Z"), "Asia/Kolkata"), "2026-11-16");
  assert.match(queueTimeRange("2026-11-16T04:30:00Z", "2026-11-16T04:45:00Z", "Asia/Kolkata"), /10:00.*10:15/i);
});
it("coalesces repeated refreshes instead of overlapping requests", async () => {
  const visibility = new EventTarget(); visibility.hidden = false;
  const requests = [], data = [];
  const poller = createQueuePoller({ visibility, interval: 100000,
    load: signal => new Promise(resolve => requests.push({ signal, resolve })), onData: value => data.push(value), onError: error => { throw error; } });
  try {
    poller.refresh(); poller.refresh(); assert.equal(requests.length, 1);
    requests[0].resolve("first"); await pause(1); assert.equal(requests.length, 2);
    requests[1].resolve("second"); await pause(1); assert.deepEqual(data, ["first", "second"]);
  } finally { poller.stop(); }
});
it("suspends hidden tabs, ignores aborted replies and cleans up on unmount", async () => {
  const visibility = new EventTarget(); visibility.hidden = false;
  const requests = [], data = [];
  const poller = createQueuePoller({ visibility, load: signal => new Promise(resolve => requests.push({ signal, resolve })),
    onData: value => data.push(value), onError: () => {} });
  visibility.hidden = true; visibility.dispatchEvent(new Event("visibilitychange"));
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve("stale"); await pause(1); assert.deepEqual(data, []);
  visibility.hidden = false; visibility.dispatchEvent(new Event("visibilitychange"));
  assert.equal(requests.length, 2);
  poller.stop(); requests[1].resolve("after unmount"); await pause(1);
  visibility.dispatchEvent(new Event("visibilitychange")); assert.equal(requests.length, 2); assert.deepEqual(data, []);
});
