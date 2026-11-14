import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appointmentFormSchema, bookingHoldUrl, bookingReviewUrl, bookingSelectionSchema, matchBookingSelection, recoverBookingHold } from "../lib/appointment-validation.ts";

const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
const end = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().slice(0, 16);
const doctorProfileId = "00000000-0000-4000-8000-000000000001";

describe("appointment form validation", () => {
  it("accepts future appointment times for a selected doctor", () => {
    assert.equal(appointmentFormSchema.safeParse({ doctorProfileId, startsAt: start, endsAt: end }).success, true);
  });

  it("rejects missing doctor and invalid times", () => {
    assert.equal(appointmentFormSchema.safeParse({ doctorProfileId: "", startsAt: "bad", endsAt: "bad" }).success, false);
  });

  it("rejects past starts and ends before starts", () => {
    assert.equal(appointmentFormSchema.safeParse({ doctorProfileId, startsAt: "2000-01-01T10:00", endsAt: end }).success, false);
    assert.equal(appointmentFormSchema.safeParse({ doctorProfileId, startsAt: end, endsAt: start }).success, false);
  });
});

describe("appointment hold recovery", () => {
  const id = "00000000-0000-4000-8000-000000000002";
  const hold = { id, doctorProfileId, doctorName: "Doctor", specialty: "Cardiology", startsAt: "2027-01-04T04:30:00.000Z", endsAt: "2027-01-04T05:00:00.000Z", status: "pending_payment", holdExpiresAt: "2027-01-01T00:10:00.000Z", consultationFeeInr: 500 };
  it("recovers an owned hold using only a credentialed GET", async () => {
    const calls = [];
    const result = await recoverBookingHold(id, async (url, options) => { calls.push({ url, options }); return Response.json(hold); }, Date.parse("2027-01-01T00:00:00Z"));
    assert.equal(result.kind, "hold");
    assert.equal(result.hold.consultationFeeInr, 500);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/appointments/${id}/hold`);
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[0].options.method, undefined);
    assert.equal(new URL(bookingHoldUrl(id), "https://example.test").searchParams.get("holdId"), id);
  });
  it("rejects expired, malformed and mismatched holds", async () => {
    assert.equal((await recoverBookingHold(id, async () => Response.json(hold), Date.parse(hold.holdExpiresAt))).kind, "unavailable");
    assert.equal((await recoverBookingHold(id, async () => Response.json({ ...hold, id: doctorProfileId }), 0)).kind, "unavailable");
    assert.equal((await recoverBookingHold("bad", async () => { assert.fail("unexpected request"); })).kind, "unavailable");
  });
  it("distinguishes a scheduled appointment without exposing unavailable holds", async () => {
    const scheduled = async (url) => url.endsWith("/hold") ? new Response(null, { status: 404 }) : Response.json({ id, status: "scheduled" });
    assert.equal((await recoverBookingHold(id, scheduled)).kind, "scheduled");
    assert.equal((await recoverBookingHold(id, async () => new Response(null, { status: 404 }))).kind, "unavailable");
    assert.equal((await recoverBookingHold(id, async () => new Response(null, { status: 403 }))).kind, "unavailable");
    assert.equal((await recoverBookingHold(id, async () => { throw new Error("offline"); })).kind, "unavailable");
  });
});

describe("assistant booking handoff", () => {
  const slot = { startsAt: "2027-01-04T04:30:00.000Z", endsAt: "2027-01-04T05:00:00.000Z" };
  const selection = { doctorProfileId, date: "2027-01-04", ...slot };

  it("carries the doctor, date, and slot to the booking review", () => {
    const url = new URL(bookingReviewUrl(selection), "https://example.test");
    assert.equal(url.pathname, "/patient/book-appointment");
    assert.equal(url.hash, "#booking-form");
    assert.deepEqual(bookingSelectionSchema.parse(Object.fromEntries(url.searchParams)), selection);
    assert.equal(bookingSelectionSchema.safeParse({ doctorProfileId }).success, true);
    assert.equal(bookingSelectionSchema.safeParse({ doctorProfileId, startsAt: slot.startsAt }).success, false);
  });

  it("preselects only a slot that still matches the doctor and date in fresh availability", () => {
    const availability = { doctorProfileId, date: selection.date, slots: [slot] };
    assert.equal(matchBookingSelection(selection, availability), slot);
    assert.equal(matchBookingSelection(selection, { ...availability, slots: [] }), null);
    assert.equal(matchBookingSelection(selection, { ...availability, date: "2027-01-05" }), null);
    assert.equal(matchBookingSelection(selection, { ...availability, doctorProfileId: "another-doctor" }), null);
    assert.equal(matchBookingSelection({ ...selection, endsAt: "2027-01-04T05:15:00.000Z" }, availability), null);
  });
});
