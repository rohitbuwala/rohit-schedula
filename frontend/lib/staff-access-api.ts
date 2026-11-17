import { z } from "zod";
const opaqueId = z.string().min(1).max(128);
export const staffAccountSchema = z.object({ id: opaqueId, name: z.string(), email: z.email(), role: z.literal("staff") });
export const staffCandidateSchema = z.object({ id: opaqueId, name: z.string(), email: z.email(),
  role: z.enum(["patient", "doctor", "admin", "staff"]), eligible: z.boolean(),
  reason: z.enum(["already_staff", "protected_role", "clinical_records"]).nullable() });
export const staffAssignmentSchema = z.object({ id: z.uuid(), staffId: opaqueId, doctorId: opaqueId, assignedBy: opaqueId,
  createdAt: z.iso.datetime({ offset: true }), revokedAt: z.iso.datetime({ offset: true }).nullable() });
const approvedDoctorSchema = z.object({ userId: opaqueId, name: z.string(), specialty: z.string(), status: z.literal("approved") });
export type StaffAccount = z.infer<typeof staffAccountSchema>;
export type StaffCandidate = z.infer<typeof staffCandidateSchema>;
export type StaffAssignment = z.infer<typeof staffAssignmentSchema>;
export class StaffAccessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function call<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, body?: unknown, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(path, { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "include",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new StaffAccessError(response.status === 401 ? "Your session expired. Sign in again."
    : response.status === 403 ? "Only administrators can manage staff access."
      : response.status === 404 ? "The account or approved doctor was not found."
        : response.status === 409 ? "This account or assignment changed, or the account is not eligible. Refresh and review before retrying."
          : "Staff access is temporarily unavailable. Refresh before retrying.", response.status);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new StaffAccessError("Staff access information could not be verified. Refresh to try again.", 502);
  return parsed.data;
}
export async function readStaffPage(offset: number, signal?: AbortSignal) {
  const items = await call(`/api/admin/staff?${new URLSearchParams({ limit: "51", offset: String(offset) })}`, z.array(staffAccountSchema).max(51), signal);
  return { items: items.slice(0, 50), hasNext: items.length > 50 };
}
export async function findStaffCandidate(email: string, signal?: AbortSignal) {
  const normalized = z.email().parse(email.trim().toLowerCase());
  const result = await call(`/api/admin/staff/candidate?${new URLSearchParams({ email: normalized })}`, staffCandidateSchema, signal);
  if (result.email.toLowerCase() !== normalized) throw new StaffAccessError("The account response did not match your search.", 502);
  return result;
}
export async function readStaffAssignments(staffId: string, signal?: AbortSignal) {
  const records = await call(`/api/admin/staff/${encodeURIComponent(staffId)}/assignments`, z.array(staffAssignmentSchema), signal);
  if (records.some(item => item.staffId !== staffId)) throw new StaffAccessError("Assignments did not match the selected staff account.", 502);
  return records;
}
export async function readAssignableDoctors(signal?: AbortSignal) {
  const doctors = await call("/api/admin/doctor-applications?status=approved", z.array(approvedDoctorSchema), signal);
  return doctors.map(({ userId, name, specialty }) => ({ doctorId: userId, name, specialty }));
}
export const provisionStaff = (userId: string, signal?: AbortSignal) => call("/api/admin/staff", staffAccountSchema, signal, { userId, confirmed: true });
export const createStaffAccount = (input: { name: string; email: string; password: string }, signal?: AbortSignal) => call("/api/admin/staff/accounts", staffAccountSchema, signal, input);
const registrationStatusSchema = z.object({ status: z.enum(["pending", "approved"]) });
export const registerStaff = (input: { name: string; email: string; password: string }, signal?: AbortSignal) => call("/api/staff-registration", registrationStatusSchema, signal, input);
export const readStaffRegistration = (signal?: AbortSignal) => call("/api/staff-registration/me", registrationStatusSchema, signal);
export const readPendingStaff = (signal?: AbortSignal) => call("/api/admin/staff/requests", z.array(z.object({ id: opaqueId, name: z.string(), email: z.email(), requestedAt: z.iso.datetime({ offset: true }) })).max(50), signal);
export const approveStaff = (id: string, signal?: AbortSignal) => call(`/api/admin/staff/requests/${encodeURIComponent(id)}/approve`, registrationStatusSchema, signal, {});
export async function assignStaffDoctor(staffId: string, doctorId: string, signal?: AbortSignal) {
  const record = await call(`/api/admin/staff/${encodeURIComponent(staffId)}/assignments`, staffAssignmentSchema, signal, { doctorId });
  if (record.staffId !== staffId || record.doctorId !== doctorId) throw new StaffAccessError("Refresh to verify the assignment result.", 502);
  return record;
}
export async function revokeStaffDoctor(staffId: string, doctorId: string, signal?: AbortSignal) {
  const record = await call(`/api/admin/staff/${encodeURIComponent(staffId)}/assignments/${encodeURIComponent(doctorId)}/revoke`, staffAssignmentSchema, signal, {});
  if (record.staffId !== staffId || record.doctorId !== doctorId || !record.revokedAt) throw new StaffAccessError("Refresh to verify that access was revoked.", 502);
  return record;
}
