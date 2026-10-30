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

  it("accepts full patient profile with all essential fields", () => {
    const validFull = {
      name: "Alex Patient",
      image: "https://images.example.test/photo.jpg",
      dateOfBirth: "1990-08-20",
      gender: "male",
      phone: "+919876543210",
      bloodGroup: "O+",
      address: "123 Health Ave, Mumbai",
      allergies: "Peanuts",
    };
    assert.equal(patientProfileFormSchema.safeParse(validFull).success, true);
  });

  it("accepts optional fields as empty strings or omitted", () => {
    const withEmpties = {
      name: "Alex Patient",
      image: "",
      dateOfBirth: "1992-04-10",
      gender: "other",
      phone: "9876543210",
      bloodGroup: "",
      address: "",
      allergies: "",
    };
    assert.equal(patientProfileFormSchema.safeParse(withEmpties).success, true);
  });

  it("rejects invalid names, insecure image URLs, and extra identity fields", () => {
    assert.equal(patientProfileFormSchema.safeParse({ name: "A", image: "" }).success, false);
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex Patient", image: "http://example.test/a.png" }).success, false);
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex Patient", image: "", userId: "other" }).success, false);
  });

  it("rejects future date of birth, invalid phone format, and invalid blood group", () => {
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex", dateOfBirth: "2099-01-01" }).success, false);
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex", phone: "123" }).success, false);
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex", bloodGroup: "X+" }).success, false);
    assert.equal(patientProfileFormSchema.safeParse({ name: "Alex", gender: "invalid" }).success, false);
  });
});
