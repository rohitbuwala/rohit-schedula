import assert from "node:assert/strict";
import { it } from "node:test";
import { bookingStorageKey, clearBookingAttempt, createBookingHold, emptyBookingDraft, matchDoctor, matchSlot, parseBookingDate, readBookingAttempt, saveBookingAttempt } from "../components/assistant/assistant-booking-draft.ts";
import { hasUnfinishedBookingDraft } from "../components/assistant/assistant-booking-draft.ts";

it("resumes normal chat after a booking result while preserving unfinished draft recovery", () => {
  assert.equal(hasUnfinishedBookingDraft(false, null), false);
  assert.equal(hasUnfinishedBookingDraft(true, null), true);
  assert.equal(hasUnfinishedBookingDraft(true, null, "find my booking"), false);
  assert.equal(hasUnfinishedBookingDraft(true, null, "show my appointments"), false);
  assert.equal(hasUnfinishedBookingDraft(true, null, "cancel my booking"), true);
  const hold = { id: "hold", startsAt: "2027-01-04T04:30:00Z", endsAt: "2027-01-04T05:00:00Z", holdExpiresAt: "2027-01-01T00:10:00Z" };
  // Questions such as 'find my booking' must reach the assistant both before
  // payment and after payment, even though the result card remains open.
  assert.equal(hasUnfinishedBookingDraft(true, { ...hold, status: "pending_payment" }), false);
  assert.equal(hasUnfinishedBookingDraft(true, { ...hold, status: "scheduled", holdExpiresAt: null }), false);
  assert.equal(hasUnfinishedBookingDraft(true, { ...hold, status: "cancelled" }), false);
});

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

it("restores the same patient-scoped key and exact payload after reload and retry", async () => {
  const storage = memoryStorage();
  const attempt = { key: "00000000-0000-4000-8000-000000000002", payload: { doctorProfileId: "00000000-0000-4000-8000-000000000001", startsAt: "2027-01-04T04:30:00.000Z", endsAt: "2027-01-04T05:00:00.000Z" } };
  assert.equal(saveBookingAttempt(storage, "patient-a", attempt), true);
  assert.equal(readBookingAttempt(storage, "patient-b").kind, "missing");
  const restored = readBookingAttempt(storage, "patient-a");
  assert.equal(restored.kind, "found");
  assert.deepEqual(restored.attempt, attempt);
  const calls = [];
  const offline = async (_url, options) => { calls.push(options); throw new Error("connection lost"); };
  assert.equal((await createBookingHold(attempt, offline, "patient-a")).kind, "uncertain");
  assert.equal((await createBookingHold(restored.attempt, offline, "patient-a")).kind, "uncertain");
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[1].headers["Idempotency-Key"], attempt.key);
  assert.equal(calls[1].headers["X-Booking-Patient"], "patient-a");
  assert.equal(readBookingAttempt(storage, "patient-a").kind, "found");
  assert.equal(clearBookingAttempt(storage, "patient-a"), true);
  assert.equal(readBookingAttempt(storage, "patient-a").kind, "missing");
});

it("blocks malformed, foreign, stale and inaccessible storage without silently deleting it", () => {
  const storage = memoryStorage();
  const key = bookingStorageKey("patient-a");
  storage.setItem(key, "not-json");
  assert.notEqual(readBookingAttempt(storage, "patient-a").kind, "missing");
  assert.equal(storage.getItem(key), "not-json");
  const stale = { key: "00000000-0000-4000-8000-000000000002", payload: { doctorProfileId: "00000000-0000-4000-8000-000000000001", startsAt: "2001-01-01T00:00:00Z", endsAt: "2001-01-01T00:30:00Z" } };
  assert.equal(saveBookingAttempt(storage, "patient-a", stale), true);
  assert.equal(readBookingAttempt(storage, "patient-a").kind, "found");
  storage.setItem(key, JSON.stringify({ version: 1, patientId: "patient-b", attempt: stale }));
  assert.equal(readBookingAttempt(storage, "patient-a").kind, "invalid");
  assert.equal(saveBookingAttempt({ setItem() { throw new Error("denied"); }, getItem() { return null; } }, "patient-a", stale), false);
  assert.equal(readBookingAttempt({ getItem() { throw new Error("denied"); } }, "patient-a").kind, "unavailable");
});

it("selects only a uniquely matched doctor and resets every selection", () => {
  const doctors = [{ id: "1", name: "Dr. Maya Shah", specialty: "Cardiology", consultationFeeInr: 500 }, { id: "2", name: "Maya Mehta", specialty: "Dental", consultationFeeInr: null }];
  assert.equal(matchDoctor("Maya", doctors), null);
  assert.equal(matchDoctor("Maya Shah", doctors)?.id, "1");
  assert.deepEqual(emptyBookingDraft(), { doctor: null, date: "", slot: null, timezone: "Asia/Kolkata", fee: null });
});

it("reuses the exact key and payload after an uncertain response", async () => {
  const attempt = { key: "00000000-0000-4000-8000-000000000002", payload: { doctorProfileId: "00000000-0000-4000-8000-000000000001", startsAt: "2027-01-04T04:30:00.000Z", endsAt: "2027-01-04T05:00:00.000Z" } };
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) throw new TypeError("network failure");
    return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000003", ...attempt.payload, status: "pending_payment", holdExpiresAt: "2027-01-01T00:10:00.000Z" }), { status: 200 });
  };
  assert.deepEqual(await createBookingHold(attempt, request), { kind: "uncertain" });
  const result = await createBookingHold(attempt, request);
  assert.equal(result.kind, "result");
  assert.equal(requests[0].options.body, requests[1].options.body);
  assert.equal(requests[0].options.headers["Idempotency-Key"], attempt.key);
  assert.equal(requests[1].options.headers["Idempotency-Key"], attempt.key);
  assert.equal(requests[0].options.credentials, "include");
});

it("distinguishes slot conflicts from idempotency conflicts and uncertain failures", async () => {
  const attempt = { key: "key", payload: { doctorProfileId: "doctor", startsAt: "2027-01-04T04:30:00.000Z", endsAt: "2027-01-04T05:00:00.000Z" } };
  const response = (status, message) => async () => new Response(JSON.stringify({ message }), { status });
  assert.equal((await createBookingHold(attempt, response(409, "The doctor is already booked for that time."))).kind, "conflict");
  assert.equal((await createBookingHold(attempt, response(409, "Idempotency key was used for a different booking."))).kind, "key_conflict");
  assert.equal((await createBookingHold(attempt, response(409, "unknown"))).kind, "uncertain");
  assert.equal((await createBookingHold(attempt, response(503, "unavailable"))).kind, "uncertain");
  assert.equal((await createBookingHold(attempt, response(401, "unauthorized"))).kind, "rejected");
  assert.equal((await createBookingHold(attempt, response(200, "bad result"))).kind, "uncertain");
});

it("interprets tomorrow in the selected timezone and rejects invalid dates", () => {
  assert.equal(parseBookingDate("tomorrow", "Asia/Kolkata", new Date("2026-11-12T20:00:00Z")), "2026-11-14");
  assert.equal(parseBookingDate("2026-02-30", "UTC"), null);
  assert.equal(parseBookingDate("next week", "UTC"), null);
});

it("matches only one available local time and rejects ambiguous or malformed slots", () => {
  const slots = [{ startsAt: "2026-11-13T04:30:00Z", endsAt: "2026-11-13T05:00:00Z" }];
  assert.equal(matchSlot("10 am", slots, "Asia/Kolkata"), slots[0]);
  assert.equal(matchSlot("10:00", [...slots, slots[0]], "Asia/Kolkata"), null);
  assert.equal(matchSlot("10", slots, "Asia/Kolkata"), null);
  assert.equal(matchSlot("25:00", slots, "Asia/Kolkata"), null);
});
