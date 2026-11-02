import { z } from "zod";

export const refundDetailsSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "processed", "failed"]),
  amountPaise: z.number().int(),
  currency: z.string().default("INR"),
  arn: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});
export type RefundDetails = z.infer<typeof refundDetailsSchema>;

export const patientPaymentSchema = z.object({
  id: z.string(),
  status: z.enum(["created", "captured", "failed", "refunded"]),
  statusDisplay: z.string(),
  amountPaise: z.number().int(),
  currency: z.string().default("INR"),
  method: z.string().optional(),
  razorpayPaymentId: z.string().nullable().optional(),
  refundedAmountPaise: z.number().int().optional(),
  refund: refundDetailsSchema.nullable().optional(),
});
export type PatientPayment = z.infer<typeof patientPaymentSchema>;

export const doctorPaymentSchema = z.object({
  status: z.enum(["created", "captured", "failed", "refunded"]),
  statusDisplay: z.string(),
  amountPaise: z.number().int(),
  currency: z.string().default("INR"),
});
export type DoctorPayment = z.infer<typeof doctorPaymentSchema>;

export const patientAppointmentSchema = z.object({
  id: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(["pending_payment", "scheduled", "cancelled", "completed"]),
  holdExpiresAt: z.string().nullable().optional(),
  doctor: z.object({
    id: z.string().uuid(),
    name: z.string(),
    specialty: z.string(),
    bio: z.string().nullable().optional(),
  }),
  payment: patientPaymentSchema.nullable().optional(),
});

export const patientAppointmentsResponseSchema = z.array(patientAppointmentSchema);
export type PatientAppointment = z.infer<typeof patientAppointmentSchema>;

export const doctorAppointmentSchema = z.object({
  id: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(["pending_payment", "scheduled", "cancelled", "completed"]),
  holdExpiresAt: z.string().nullable().optional(),
  patient: z.object({
    id: z.string(),
    name: z.string(),
  }),
  payment: doctorPaymentSchema.nullable().optional(),
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
