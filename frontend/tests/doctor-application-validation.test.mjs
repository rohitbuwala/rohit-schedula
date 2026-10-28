import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { doctorApplicationFormSchema } from "../lib/doctor-application-validation.ts";

describe("doctor application validation", () => {
  it("accepts valid application details and trims whitespace", () => {
    const result = doctorApplicationFormSchema.parse({
      specialty: "  Cardiology  ",
      licenseRegion: "  Test Region  ",
      licenseNumber: "  ABC-123  ",
      bio: "  Test bio  ",
    });
    assert.deepEqual(result, {
      specialty: "Cardiology",
      licenseRegion: "Test Region",
      licenseNumber: "ABC-123",
      bio: "Test bio",
    });
  });

  it("rejects short values, overlong values, and client-supplied identity fields", () => {
    assert.equal(doctorApplicationFormSchema.safeParse({ specialty: "A", licenseRegion: "XY", licenseNumber: "123", bio: "" }).success, false);
    assert.equal(doctorApplicationFormSchema.safeParse({ specialty: "Cardiology", licenseRegion: "Test", licenseNumber: "123", bio: "x".repeat(1001) }).success, false);
    assert.equal(doctorApplicationFormSchema.safeParse({ specialty: "Cardiology", licenseRegion: "Test", licenseNumber: "123", bio: "", role: "doctor" }).success, false);
  });
});
