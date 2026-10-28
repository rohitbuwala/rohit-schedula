import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patientProfileFormSchema } from "../lib/patient-profile-validation.ts";

describe("patient profile validation", () => {
  it("accepts a valid name and optional HTTPS image URL", () => {
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex Patient", image: "https://images.example.test/a.png" }).success, true);
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex Patient", image: "" }).success, true);
  });

  it("accepts a name-only update when a legacy image is omitted", () => {
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex Patient" }).success, true);
  });

  it("rejects invalid names, insecure image URLs, and extra identity fields", () => {
    assert.equal(patientProfileFormSchema.safeParse({ name: "A", image: "" }).success, false);
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex Patient", image: "http://example.test/a.png" }).success, false);
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex Patient", image: "", userId: "other" }).success, false);
  });
});
