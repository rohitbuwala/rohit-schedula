import { z } from "zod";

export const patientAppointmentSchema = z.object({
  id: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(["scheduled", "cancelled", "completed"]),
  doctor: z.object({
    id: z.string().uuid(),
    name: z.string(),
    specialty: z.string(),
    bio: z.string().nullable().optional(),
  }),
});

export const patientAppointmentsResponseSchema = z.array(patientAppointmentSchema);
export type PatientAppointment = z.infer<typeof patientAppointmentSchema>;

export const doctorAppointmentSchema = z.object({
  id: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(["scheduled", "cancelled", "completed"]),
  patient: z.object({
    id: z.string(),
    name: z.string(),
  }),
});

export const doctorAppointmentsResponseSchema = z.array(doctorAppointmentSchema);
export type DoctorAppointment = z.infer<typeof doctorAppointmentSchema>;

export function parsePatientAppointmentsResponseBody(body: string): PatientAppointment[] {
  if (body.trim().length === 0) return [];

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Appointments response returned invalid JSON.");
  }

  const parsed = patientAppointmentsResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Appointments response returned an unexpected shape.");
  }
  return parsed.data;
}

export function parseDoctorAppointmentsResponseBody(body: string): DoctorAppointment[] {
  if (body.trim().length === 0) return [];

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Appointments response returned invalid JSON.");
  }

  const parsed = doctorAppointmentsResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Appointments response returned an unexpected shape.");
  }
  return parsed.data;
}
