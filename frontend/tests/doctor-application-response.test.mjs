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

  it("parses a valid application response without extended fields", () => {
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
    const result = parseDoctorApplicationResponseBody(JSON.stringify(application));
    assert.equal(result?.id, application.id);
    assert.equal(result?.specialty, application.specialty);
    assert.equal(result?.status, "pending");
  });

  it("parses a valid application response with extended fields and rejectionReason", () => {
    const application = {
      id: "11111111-1111-4111-8111-111111111111",
      specialty: "Cardiology",
      licenseRegion: "MH",
      licenseNumber: "MCI-12345",
      bio: "Experienced cardiologist.",
      phone: "+919876543210",
      qualifications: "MBBS, MD",
      yearsOfExperience: 10,
      consultationFeeInr: 500,
      clinicName: "City Medical Centre",
      clinicAddress: "123 Main Street, Mumbai",
      profilePhotoUrl: null,
      status: "rejected",
      submittedAt: "2026-10-28T10:00:00.000Z",
      reviewedAt: "2026-10-29T10:00:00.000Z",
      rejectionReason: "Medical registration number not found on state council records.",
    };
    const result = parseDoctorApplicationResponseBody(JSON.stringify(application));
    assert.equal(result?.consultationFeeInr, 500);
    assert.equal(result?.yearsOfExperience, 10);
    assert.equal(result?.clinicName, "City Medical Centre");
    assert.equal(result?.phone, "+919876543210");
    assert.equal(result?.status, "rejected");
    assert.equal(result?.rejectionReason, "Medical registration number not found on state council records.");
  });

  it("rejects malformed non-empty JSON and invalid response shapes", () => {
    assert.throws(() => parseDoctorApplicationResponseBody("{"), /invalid JSON/i);
    assert.throws(() => parseDoctorApplicationResponseBody("{}"), /unexpected response/i);
  });
});
