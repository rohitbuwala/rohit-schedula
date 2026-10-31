import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loginSchema,
  signupSchema,
  patientSignupSchema,
  doctorRegistrationSchema,
} from "../lib/auth-validation.ts";

describe("auth validation", () => {
  it("accepts valid patient signup fields without a client role", () => {
    const result = signupSchema.parse({
      name: "Alex Patient",
      email: "alex@example.com",
      password: "secure-pass-123",
      confirmPassword: "secure-pass-123",
      role: "doctor",
    });
    assert.equal("role" in result, false);
  });

  it("rejects weak passwords, invalid email and mismatched confirmation", () => {
    assert.equal(
      signupSchema.safeParse({
        name: "A",
        email: "bad",
        password: "short",
        confirmPassword: "different",
      }).success,
      false
    );
  });

  it("requires a valid login email and password", () => {
    assert.equal(loginSchema.safeParse({ email: "invalid", password: "" }).success, false);
    assert.equal(loginSchema.safeParse({ email: "alex@example.com", password: "ok" }).success, true);
  });

  describe("patientSignupSchema", () => {
    it("accepts a valid patient registration without phone", () => {
      const res = patientSignupSchema.safeParse({
        name: "Priya Sharma",
        email: "priya@example.com",
        password: "password123",
        confirmPassword: "password123",
      });
      assert.equal(res.success, true);
    });

    it("accepts a valid patient registration with optional phone", () => {
      const res = patientSignupSchema.safeParse({
        name: "Priya Sharma",
        email: "priya@example.com",
        phone: "+919876543210",
        password: "password123",
        confirmPassword: "password123",
      });
      assert.equal(res.success, true);
    });

    it("rejects an invalid phone format for patient", () => {
      const res = patientSignupSchema.safeParse({
        name: "Priya Sharma",
        email: "priya@example.com",
        phone: "123", // too short
        password: "password123",
        confirmPassword: "password123",
      });
      assert.equal(res.success, false);
    });

    it("rejects mismatched passwords for patient", () => {
      const res = patientSignupSchema.safeParse({
        name: "Priya Sharma",
        email: "priya@example.com",
        password: "password123",
        confirmPassword: "mismatchPassword",
      });
      assert.equal(res.success, false);
    });
  });

  describe("doctorRegistrationSchema", () => {
    const validDoctor = {
      name: "Dr. Rajesh Gupta",
      email: "rajesh@hospital.org",
      phone: "+919876543210",
      password: "password123",
      confirmPassword: "password123",
      specialty: "Cardiology",
      licenseRegion: "National Medical Commission",
      licenseNumber: "NMC-2015-12345",
      qualifications: "MBBS, MD (Cardiology)",
      yearsOfExperience: 8,
      consultationFeeInr: 600,
      clinicName: "Apollo Clinics",
      clinicAddress: "123 Health Ave, Bengaluru",
      bio: "Dedicated interventional cardiologist with over 8 years experience.",
    };

    it("accepts a complete, valid doctor registration", () => {
      const res = doctorRegistrationSchema.safeParse(validDoctor);
      assert.equal(res.success, true);
      if (res.success) {
        assert.equal(res.data.specialty, "Cardiology");
        assert.equal(res.data.yearsOfExperience, 8);
        assert.equal(res.data.consultationFeeInr, 600);
      }
    });

    it("rejects doctor registration when required medical credentials are missing", () => {
      const missingLicense = { ...validDoctor, licenseNumber: "" };
      assert.equal(doctorRegistrationSchema.safeParse(missingLicense).success, false);

      const missingSpecialty = { ...validDoctor, specialty: "" };
      assert.equal(doctorRegistrationSchema.safeParse(missingSpecialty).success, false);
    });

    it("rejects negative years of experience", () => {
      const negativeExp = { ...validDoctor, yearsOfExperience: -2 };
      assert.equal(doctorRegistrationSchema.safeParse(negativeExp).success, false);
    });

    it("rejects experience exceeding maximum allowed", () => {
      const excessiveExp = { ...validDoctor, yearsOfExperience: 99 };
      assert.equal(doctorRegistrationSchema.safeParse(excessiveExp).success, false);
    });

    it("rejects mismatched passwords for doctor", () => {
      const mismatch = { ...validDoctor, confirmPassword: "wrong" };
      assert.equal(doctorRegistrationSchema.safeParse(mismatch).success, false);
    });
  });
});
