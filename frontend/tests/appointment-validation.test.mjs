import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appointmentFormSchema } from "../lib/appointment-validation.ts";

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
