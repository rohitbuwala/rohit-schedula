import assert from "node:assert/strict";
import { it } from "node:test";
import { confirmAssistantCancellation, confirmAssistantReschedule, getAssistantRescheduleOptions, sendAssistantMessage, synthesizeAssistantAudio, transcribeAssistantAudio } from "../lib/assistant-api.ts";

const id = "00000000-0000-4000-8000-000000000001";
const slot = { startsAt: "2026-11-12T05:00:00Z", endsAt: "2026-11-12T05:30:00Z" };
const appointment = { id, ...slot, status: "scheduled" };
const doctor = { id, name: "Dr. Test", specialty: "Cardiology" };
const zone = { date: "2026-11-12", timezone: "Asia/Kolkata" };

it("requests authenticated synthesized audio and rejects provider errors", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/assistant/voice/synthesize");
    assert.equal(options.credentials, "include");
    assert.deepEqual(JSON.parse(options.body), { text: "hello", language: "hi" });
    return new Response("audio", { headers: { "content-type": "audio/wav" } });
  });
  assert.equal((await synthesizeAssistantAudio("hello", "hi")).size, 5);
  mock.mock.mockImplementation(async () => new Response("private", { status: 503 }));
  await assert.rejects(synthesizeAssistantAudio("hello", "en"), (error) => error.status === 503 && !error.message.includes("private"));
});

it("uploads WAV using authenticated multipart and accepts empty transcript", async (t) => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/assistant/voice/transcribe");
    assert.equal(options.credentials, "include");
    assert.equal(options.method, "POST");
    assert.equal(options.signal, signal);
    assert.equal(options.body.get("file").type, "audio/wav");
    assert.equal(options.headers, undefined);
    return Response.json({ transcript: "  " });
  });
  assert.equal(await transcribeAssistantAudio(new Blob(["data"], { type: "audio/wav" }), signal), "");
});

it("sanitizes transcription API errors and rejects malformed transcripts", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("private details", { status: 503 }));
  await assert.rejects(transcribeAssistantAudio(new Blob()), (error) => error.status === 503 && !error.message.includes("private"));
  mock.mock.mockImplementation(async () => Response.json({ transcript: 42 }));
  await assert.rejects(transcribeAssistantAudio(new Blob()), /unexpected response/);
});

it("reads options before explicitly confirming a reschedule", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.method) {
      assert.equal(url, `/api/assistant/appointments/${id}/reschedule-options`);
      return Response.json({ currentStartsAt: slot.startsAt, timezone: zone.timezone, slots: [slot] });
    }
    assert.equal(url, "/api/assistant/appointments/reschedule");
    assert.equal(options.method, "PATCH");
    assert.equal(options.credentials, "include");
    assert.deepEqual(JSON.parse(options.body), { appointmentId: id, expectedStartsAt: slot.startsAt, slot, confirmed: true });
    return Response.json(slot);
  });
  const options = await getAssistantRescheduleOptions(id);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await confirmAssistantReschedule(id, options.currentStartsAt, options.slots[0]), slot);
  assert.equal(fetch.mock.callCount(), 2);
});

it("sends cancellation only with a valid reason and explicit confirmation", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/assistant/appointments/cancel");
    assert.equal(options.method, "PATCH");
    assert.equal(options.credentials, "include");
    assert.deepEqual(JSON.parse(options.body), { appointmentId: id, reason: "schedule_conflict", confirmed: true });
    return Response.json({ status: "cancelled" });
  });
  await assert.rejects(confirmAssistantCancellation(id, ""), { status: 400 });
  assert.equal(fetch.mock.callCount(), 0);
  await confirmAssistantCancellation(id, "schedule_conflict");
  assert.equal(fetch.mock.callCount(), 1);
});

it("sends only the trimmed message through the same-origin authenticated endpoint", async (t) => {
  const { signal } = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/assistant/chat");
    assert.deepEqual(options, { method: "POST", credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: '{"message":"Show appointments"}', signal });
    return Response.json({ tool: "clarify", reply: "Which date?", data: null });
  });
  assert.equal((await sendAssistantMessage(" Show appointments ", signal)).reply, "Which date?");
});

for (const [tool, data] of Object.entries({
  clarify: null,
  start_booking: { doctorProfileId: id, doctorName: "Dr. Test", date: zone.date, time: "10:00", specialty: "Cardiology" },
  payment_history: { payments: [{ appointmentStartsAt: slot.startsAt, doctorName: "Dr. Test",
    amountPaise: 45000, currency: "INR", paymentStatus: "captured", refundStatus: "pending" }], hasMore: false },
  list_prescriptions: { prescriptions: [{ issuedAt: slot.startsAt, doctorName: "Dr. Test",
    medications: [{ name: "Recorded medication", instructions: "Recorded instructions" }] }], hasMore: false },
  list_appointments: { filter: "all", appointments: [{ ...appointment, doctor, period: "upcoming" }], hasMore: false },
  today_appointments: { ...zone, appointments: [appointment], hasMore: true },
  doctor_appointments_by_date: { ...zone, appointments: [{ ...slot, status: "scheduled" }], hasMore: false },
  next_available_slot: { timezone: zone.timezone, horizonDays: 30, slot },
  reschedule_suggestions: { timezone: zone.timezone, slots: [slot] },
  appointment_statistics: { ...zone, total: 1, byStatus: { pending_payment: 0, scheduled: 1, completed: 0, cancelled: 0 } },
  schedule_conflicts: { ...slot, timezone: zone.timezone, conflicts: [{ id, ...slot }], hasMore: false },
  appointment_details: { ...appointment, timezone: "America/New_York" },
  search_doctors: { doctors: [{ ...doctor, consultationFeeInr: null }], hasMore: false },
  check_availability: { ...zone, doctorProfileId: id, durationMinutes: 30, slots: [slot] },
  alternative_slots: { ...zone, doctorProfileId: id, durationMinutes: 30, slots: [slot] },
  view_schedule: { timezone: zone.timezone, activeDays: [1, 2], startHour: 9, endHour: 24,
    slotDurationMinutes: 30, breakStart: null, breakEnd: null, leaveDates: [zone.date] },
})) {
  it(`parses ${tool}`, async (t) => {
    const response = { tool, reply: "Here is the result.", data };
    t.mock.method(globalThis, "fetch", async () => Response.json(response));
    assert.deepEqual(await sendAssistantMessage("Show appointments"), response);
  });
}

it("rejects blank and oversized messages before fetching", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  for (const input of ["  ", "a".repeat(1001)]) {
    await assert.rejects(sendAssistantMessage(input), { status: 400 });
  }
  assert.equal(fetch.mock.callCount(), 0);
});

it("maps expected errors and does not display backend error bodies", async (t) => {
  for (const status of [400, 401, 403, 404, 429, 503, 500]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("PRIVATE", { status }));
    await assert.rejects(sendAssistantMessage("Show appointments"), (error) => {
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    mock.mock.restore();
  }
});

it("rejects malformed JSON, tool payloads, and invalid timezone values", async (t) => {
  const responses = [
    new Response("<html>"),
    Response.json({ tool: "cancel_appointment", reply: "Done", data: {} }),
    Response.json({ tool: "appointment_details", reply: "Done", data: { id } }),
    Response.json({ tool: "appointment_details", reply: "Done", data: { ...appointment, timezone: "America/New_York", endsAt: appointment.startsAt } }),
    Response.json({ tool: "appointment_details", reply: "Done", data: appointment }),
    Response.json({ tool: "today_appointments", reply: "Done", data: { ...zone, timezone: "invalid", appointments: [], hasMore: false } }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  while (responses.length) {
    await assert.rejects(sendAssistantMessage("Show appointments"), /unexpected response/);
  }
});

it("preserves an aborted request", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => signal.throwIfAborted());
  await assert.rejects(sendAssistantMessage("Show appointments", AbortSignal.abort()), { name: "AbortError" });
});
