import assert from "node:assert/strict";
import { it } from "node:test";
import { patientAge } from "../lib/patient-age.ts";

it("changes age at midnight in India, including before UTC midnight", () => {
  assert.equal(patientAge("2000-11-19", new Date("2026-11-18T18:29:59Z")), "25");
  assert.equal(patientAge("2000-11-19", new Date("2026-11-18T18:30:00Z")), "26");
});

it("handles missing, invalid, future and leap-day dates", () => {
  const now = new Date("2025-02-28T12:00:00Z");
  assert.equal(patientAge(null, now), "Not provided");
  assert.equal(patientAge("2000-02-30", now), "Not provided");
  assert.equal(patientAge("2025-03-01", now), "Not provided");
  assert.equal(patientAge("2000-02-29", now), "24");
  assert.equal(patientAge("2000-02-29", new Date("2025-03-01T00:00:00Z")), "25");
});
