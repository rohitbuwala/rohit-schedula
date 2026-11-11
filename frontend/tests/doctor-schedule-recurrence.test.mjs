import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const component = await readFile(
  new URL("../components/doctor-schedule-manager.tsx", import.meta.url),
  "utf8",
);
const patientAppointments = await readFile(
  new URL("../components/patient-appointments.tsx", import.meta.url),
  "utf8",
);
const appointmentsService = await readFile(
  new URL("../../backend/src/appointments/appointments.service.ts", import.meta.url),
  "utf8",
);
const appointmentsController = await readFile(
  new URL("../../backend/src/appointments/appointments.controller.ts", import.meta.url),
  "utf8",
);

describe("doctor schedule recurrence controls", () => {
  it("exposes accessible recurring and non-recurring choices", () => {
    assert.match(component, /aria-label="Recurring or non-recurring availability"/);
    assert.match(component, />Recurring<\/button>/);
    assert.match(component, />Non-recurring<\/button>/);
    assert.match(component, /aria-pressed=\{scheduleType === "recurring"\}/);
    assert.match(component, /aria-pressed=\{scheduleType === "single"\}/);
  });

  it("routes weekly and one-date choices to their existing save forms", () => {
    assert.match(component, /scheduleType === "recurring" \? "" : "hidden"/);
    assert.match(component, /scheduleType === "single" \? "" : "hidden"/);
    assert.match(component, /fetch\(`\$\{backendUrl\}\/api\/doctor\/schedule`/);
    assert.match(component, /fetch\(`\$\{backendUrl\}\/api\/doctor\/schedule\/override`/);
  });

  it("surfaces schedule conflicts without treating a rejected update as successful", () => {
    assert.match(component, /if \(!res\.ok\) \{/);
    assert.match(component, /setConflictResult\(result\)/);
    assert.match(component, /existing appointment\(s\) or active payment hold\(s\)/);
    assert.match(component, /Schedule change request created/);
  });

  it("renders affected appointment details and separate proposal actions", () => {
    assert.match(component, /Affected Appointments/);
    assert.match(component, /item\.patient\.name/);
    assert.match(component, /item\.payment\?\.statusDisplay/);
    assert.match(component, /item\.conflictReason/);
    assert.doesNotMatch(component, />\s*Manual Reschedule\s*<\/Button>/);
    assert.match(component, />\s*Smart Reschedule\s*<\/Button>/);
    assert.match(component, /\/api\/doctor\/schedule\/requests\/\$\{proposalEditor\.requestId\}\/appointments/);
    assert.match(component, /Approve the schedule request separately to send it to the patient/);
    assert.match(component, /The appointment will not change until the patient accepts/);
    assert.match(component, /No valid alternative is available/);
    assert.match(component, /\/schedule-requests\/\$\{requestId\}\/appointments\/\$\{affectedAppointmentId\}\/cancel/);
    assert.match(component, /Recheck publication/);
    assert.match(component, /Publication is blocked/);
  });

  it("shows patient consent options with explicit accept and decline actions", () => {
    assert.ok(patientAppointments.includes('/api/appointments/schedule-requests/${request.id}/appointments/${affected.id}'));
    assert.match(patientAppointments, /alternativeId \? "accept" : "decline"/);
    assert.match(patientAppointments, /onClick=\{\(\) => void respondToScheduleChange\(request, affected, alternative\.id\)\}/);
    assert.match(patientAppointments, /onClick=\{\(\) => void respondToScheduleChange\(request, affected\)\}/);
    assert.match(patientAppointments, /Your appointment stays at its current time unless you accept/);
    assert.match(patientAppointments, /No alternative times are available/);
  });

  it("displays resolved and expired consent states and handles loading and session errors", () => {
    assert.match(patientAppointments, /"pending" \| "accepted" \| "declined" \| "expired"/);
    assert.match(patientAppointments, /request\.status === "expired"/);
    assert.match(patientAppointments, /Your session expired\. Log in again\./);
    assert.match(patientAppointments, /Loading schedule change requests/);
    assert.match(patientAppointments, /Response failed:/);
  });

  it("allows patients to review approved schedule request history after resolution", () => {
    assert.match(appointmentsService, /if \(!request \|\| !request\.approvedAt\)/);
    assert.doesNotMatch(appointmentsService, /eq\(scheduleChangeRequest\.status, 'pending'\)\)\s*\.limit\(1\);\s*if \(!request \|\| !request\.approvedAt \|\| request\.expiresAt/);
  });

  it("loads patient request history from the database-backed list endpoint", () => {
    assert.match(patientAppointments, /fetch\(`\$\{backendUrl\}\/api\/appointments\/schedule-requests`/);
    assert.doesNotMatch(patientAppointments, /fetch\(`\$\{backendUrl\}\/api\/notifications`/);
    assert.match(appointmentsController, /@Get\('schedule-requests'\)[\s\S]*?@Roles\('patient'\)[\s\S]*?listScheduleChangeRequests/);
    assert.match(appointmentsService, /eq\(appointment\.patientId, patientId\)/);
    assert.match(appointmentsService, /isNotNull\(scheduleChangeRequest\.approvedAt\)/);
    assert.match(appointmentsService, /innerJoin\(appointment, eq\(appointment\.id, scheduleChangeAppointment\.appointmentId\)\)/);
  });

  it("conditionally hides Manual and Smart controls when affected appointments are empty, displaying direct approval instructions", () => {
    // When affectedList.length === 0, renders conflict-free explanation and hides the affected appointments section
    assert.match(component, /affectedList\.length === 0 && \(/);
    assert.match(component, /No affected appointments\. This schedule change does not conflict with any existing bookings\. Approve the request to publish the new schedule immediately\./);
    // Smart reschedule button is inside affectedList.length > 0 block
    assert.match(component, /affectedList\.length > 0 && \([\s\S]*?Smart Reschedule/);
  });

  it("supports Smart checkbox alternative selection", () => {
    assert.match(component, /type="checkbox"/);
    assert.match(component, /alternativeIds: checked\s*\?\s*current\.alternativeIds\.filter/);
  });

  it("preserves explicit patient consent without auto-rescheduling", () => {
    // Appointments are never mutated during doctor schedule proposal or approval
    assert.doesNotMatch(component, /updateAppointment/);
    // Patient appointment updates only happen when the patient explicitly accepts
    assert.match(patientAppointments, /respondToScheduleChange\(request, affected, alternative\.id\)/);
    assert.match(appointmentsService, /acceptScheduleChange\([\s\S]*?update\(appointment\)/);
  });
});
