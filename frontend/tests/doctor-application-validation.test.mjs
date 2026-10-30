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
    assert.equal(result.specialty, "Cardiology");
    assert.equal(result.licenseRegion, "Test Region");
    assert.equal(result.licenseNumber, "ABC-123");
    assert.equal(result.bio, "Test bio");
  });

  it("rejects short values, overlong values, and client-supplied identity fields", () => {
    assert.equal(doctorApplicationFormSchema.safeParse({ specialty: "A", licenseRegion: "XY", licenseNumber: "123", bio: "" }).success, false);
    assert.equal(doctorApplicationFormSchema.safeParse({ specialty: "Cardiology", licenseRegion: "Test", licenseNumber: "123", bio: "x".repeat(1001) }).success, false);
    assert.equal(doctorApplicationFormSchema.safeParse({ specialty: "Cardiology", licenseRegion: "Test", licenseNumber: "123", bio: "", role: "doctor" }).success, false);
  });

  it("accepts valid extended profile fields", () => {
    const result = doctorApplicationFormSchema.safeParse({
      specialty: "Cardiology",
      licenseRegion: "MH",
      licenseNumber: "MCI-12345",
      bio: "",
      phone: "+919876543210",
      qualifications: "MBBS, MD",
      yearsOfExperience: "10",
      consultationFeeInr: "500",
      clinicName: "City Clinic",
      clinicAddress: "123 Main Street",
      profilePhotoUrl: "https://example.com/photo.jpg",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.phone, "+919876543210");
      assert.equal(result.data.yearsOfExperience, 10);
      assert.equal(result.data.consultationFeeInr, 500);
      assert.equal(result.data.clinicName, "City Clinic");
    }
  });

  it("rejects negative consultation fee", () => {
    assert.equal(doctorApplicationFormSchema.safeParse({
      specialty: "Cardiology", licenseRegion: "CA", licenseNumber: "12345",
      bio: "", consultationFeeInr: "-1",
    }).success, false);
  });

  it("rejects negative years of experience", () => {
    assert.equal(doctorApplicationFormSchema.safeParse({
      specialty: "Cardiology", licenseRegion: "CA", licenseNumber: "12345",
      bio: "", yearsOfExperience: "-1",
    }).success, false);
  });

  it("rejects invalid phone format", () => {
    assert.equal(doctorApplicationFormSchema.safeParse({
      specialty: "Cardiology", licenseRegion: "CA", licenseNumber: "12345",
      bio: "", phone: "not-a-phone",
    }).success, false);
  });

  it("accepts zero consultation fee (free consultation)", () => {
    const result = doctorApplicationFormSchema.safeParse({
      specialty: "Cardiology", licenseRegion: "CA", licenseNumber: "12345",
      bio: "", consultationFeeInr: "0",
    });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.consultationFeeInr, 0);
  });

  it("transforms empty phone to null", () => {
    const result = doctorApplicationFormSchema.safeParse({
      specialty: "Cardiology", licenseRegion: "CA", licenseNumber: "12345",
      bio: "", phone: "",
    });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.phone, null);
  });

  it("accepts missing optional fields (they remain undefined/null)", () => {
    const result = doctorApplicationFormSchema.safeParse({
      specialty: "Cardiology", licenseRegion: "CA", licenseNumber: "12345", bio: "",
    });
    assert.equal(result.success, true);
  });
});
