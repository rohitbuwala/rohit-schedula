import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDoctorApplicationResponseBody } from "../lib/doctor-application-response.ts";

describe("doctor application status response", () => {
  it("treats an empty successful response as no application", () => {
    assert.equal(parseDoctorApplicationResponseBody(""), null);
  });

  it("accepts the explicit null representation too", () => {
    assert.equal(parseDoctorApplicationResponseBody("null"), null);
  });

  it("parses a valid application response", () => {
    const application = {
      id: "11111111-1111-4111-8111-111111111111",
      specialty: "Cardiology",
      licenseRegion: "Test Region",
      licenseNumber: "ABC-123",
      bio: null,
      status: "pending",
      submittedAt: "2026-10-28T10:00:00.000Z",
      reviewedAt: null,
    };
    assert.deepEqual(parseDoctorApplicationResponseBody(JSON.stringify(application)), application);
  });

  it("rejects malformed non-empty JSON and invalid response shapes", () => {
    assert.throws(() => parseDoctorApplicationResponseBody("{"), /invalid JSON/i);
    assert.throws(() => parseDoctorApplicationResponseBody("{}"), /unexpected response/i);
  });
});
