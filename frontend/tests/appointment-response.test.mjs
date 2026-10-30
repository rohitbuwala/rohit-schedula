import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePatientAppointmentsResponseBody,
  parseDoctorAppointmentsResponseBody,
} from "../lib/appointment-response.ts";

describe("patient appointment response parsing", () => {
  const validPatientAppointment = {
    id: "a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5",
    startsAt: "2026-10-30T10:00:00.000Z",
    endsAt: "2026-10-30T10:30:00.000Z",
    status: "scheduled",
    doctor: {
      id: "b2b2b2b2-c3c3-4d4d-8e5e-f6f6f6f6f6f6",
      name: "Dr. Jane Doe",
      specialty: "Cardiology",
      bio: "Cardiologist with 10 years experience.",
    },
  };

  it("parses an empty response body as an empty array", () => {
    assert.deepEqual(parsePatientAppointmentsResponseBody(""), []);
    assert.deepEqual(parsePatientAppointmentsResponseBody("  "), []);
    assert.deepEqual(parsePatientAppointmentsResponseBody("[]"), []);
  });

  it("parses a valid list of patient appointments", () => {
    const list = [validPatientAppointment];
    const parsed = parsePatientAppointmentsResponseBody(JSON.stringify(list));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, validPatientAppointment.id);
    assert.equal(parsed[0].doctor.name, "Dr. Jane Doe");
    assert.equal(parsed[0].doctor.specialty, "Cardiology");
    assert.equal(parsed[0].status, "scheduled");
  });

  it("accepts null bio on doctor object", () => {
    const appt = {
      ...validPatientAppointment,
      doctor: { ...validPatientAppointment.doctor, bio: null },
    };
    const parsed = parsePatientAppointmentsResponseBody(JSON.stringify([appt]));
    assert.equal(parsed[0].doctor.bio, null);
  });

  it("rejects invalid JSON", () => {
    assert.throws(
      () => parsePatientAppointmentsResponseBody("{ not valid json"),
      /invalid JSON/
    );
  });

  it("rejects non-array or invalid shape", () => {
    assert.throws(
      () => parsePatientAppointmentsResponseBody(JSON.stringify({ notAnArray: true })),
      /unexpected shape/
    );
    assert.throws(
      () => parsePatientAppointmentsResponseBody(JSON.stringify([{ id: "not-a-uuid" }])),
      /unexpected shape/
    );
  });
});

describe("doctor appointment response parsing", () => {
  const validDoctorAppointment = {
    id: "a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5",
    startsAt: "2026-10-30T10:00:00.000Z",
    endsAt: "2026-10-30T10:30:00.000Z",
    status: "scheduled",
    patient: {
      id: "user-patient-123",
      name: "John Patient",
    },
  };

  it("parses an empty response body as an empty array", () => {
    assert.deepEqual(parseDoctorAppointmentsResponseBody(""), []);
    assert.deepEqual(parseDoctorAppointmentsResponseBody("[]"), []);
  });

  it("parses a valid list of doctor appointments", () => {
    const list = [validDoctorAppointment];
    const parsed = parseDoctorAppointmentsResponseBody(JSON.stringify(list));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, validDoctorAppointment.id);
    assert.equal(parsed[0].patient.name, "John Patient");
    assert.equal(parsed[0].status, "scheduled");
  });

  it("rejects invalid JSON", () => {
    assert.throws(
      () => parseDoctorAppointmentsResponseBody("{ invalid json"),
      /invalid JSON/
    );
  });

  it("rejects unexpected shape", () => {
    assert.throws(
      () => parseDoctorAppointmentsResponseBody(JSON.stringify([{}])),
      /unexpected shape/
    );
  });
});
