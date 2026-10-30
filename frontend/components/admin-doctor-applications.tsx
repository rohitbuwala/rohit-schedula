"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserX,
  XCircle,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const pendingApplicationSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  name: z.string(),
  email: z.email(),
  specialty: z.string(),
  licenseRegion: z.string(),
  licenseNumber: z.string(),
  bio: z.string().nullable(),
  phone: z.string().nullable().optional(),
  qualifications: z.string().nullable().optional(),
  yearsOfExperience: z.number().int().nullable().optional(),
  consultationFeeInr: z.number().int().nullable().optional(),
  clinicName: z.string().nullable().optional(),
  clinicAddress: z.string().nullable().optional(),
  profilePhotoUrl: z.string().nullable().optional(),
  status: z.enum(["pending", "approved", "rejected"]),
  submittedAt: z.string(),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  appointmentCount: z.number().int().optional(),
  rejectionReason: z.string().nullable().optional(),
});
const pendingApplicationsResponseSchema = z.array(pendingApplicationSchema);
type PendingApplication = z.infer<typeof pendingApplicationSchema>;

export function AdminDoctorApplications() {
  const [applications, setApplications] = useState<PendingApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeAction, setActiveAction] = useState<{ id: string; action: "approve" | "reject" | "delete" } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "all">("all");

  // Rejection prompt state
  const [promptRejectApp, setPromptRejectApp] = useState<PendingApplication | null>(null);
  const [rejectionReasonInput, setRejectionReasonInput] = useState("");
  const [rejectReasonError, setRejectReasonError] = useState("");

  const loadApplications = useCallback(async (filter: string) => {
    const response = await fetch(`${backendUrl}/api/admin/doctor-applications?status=${encodeURIComponent(filter)}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "Your session expired. Log in again."
          : response.status === 403
          ? "Administrator access is required to review applications."
          : "Could not load doctor applications."
      );
    }
    const parsed = pendingApplicationsResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Applications returned an unexpected response.");
    return parsed.data;
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setLoading(true);
        setLoadError("");
      }
    });
    loadApplications(statusFilter)
      .then((result) => {
        if (active) setApplications(result);
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(cause instanceof Error ? cause.message : "Could not load doctor applications.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadApplications, statusFilter]);

  async function retryLoad() {
    setLoading(true);
    setLoadError("");
    try {
      setApplications(await loadApplications(statusFilter));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Could not load doctor applications.");
    } finally {
      setLoading(false);
    }
  }

  async function decide(application: PendingApplication, decision: "approved" | "rejected", reason?: string) {
    setActionError("");
    setNotice("");
    setActiveAction({ id: application.id, action: decision === "approved" ? "approve" : "reject" });
    try {
      const payload: { decision: "approved" | "rejected"; reason?: string } = { decision };
      if (decision === "rejected" && reason) {
        payload.reason = reason;
      }

      const response = await fetch(
        `${backendUrl}/api/admin/doctor-applications/${encodeURIComponent(application.id)}/decision`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("Administrator access is required to review applications.");
      if (response.status === 404 || response.status === 409) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.message || "Could not update doctor application.");
      }
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.message || "Could not update the application. Please check rejection reason.");
      }

      const actionVerb = decision === "approved"
        ? (application.status === "rejected" ? "reactivated and approved" : "approved")
        : "deactivated (safe unapproval)";

      setNotice(`${application.name} was successfully ${actionVerb}. Medical records and appointment history are preserved.`);
      setApplications(await loadApplications(statusFilter));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update the application. Please try again.");
    } finally {
      setActiveAction(null);
    }
  }

  async function handleDelete(application: PendingApplication) {
    setActionError("");
    setNotice("");
    setActiveAction({ id: application.id, action: "delete" });
    try {
      const response = await fetch(
        `${backendUrl}/api/admin/doctor-applications/${encodeURIComponent(application.id)}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("Administrator access is required to delete doctors.");
      if (response.status === 409) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.message || "Cannot delete doctor: appointments exist. Deactivate the doctor instead.");
      }
      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.message || "Could not delete doctor profile.");
      }

      setNotice(`${application.name}'s doctor profile was permanently deleted.`);
      setApplications(await loadApplications(statusFilter));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not delete doctor profile.");
    } finally {
      setActiveAction(null);
    }
  }

  const filteredApplications = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return applications;
    return applications.filter(
      (app) =>
        app.name.toLowerCase().includes(q) ||
        app.specialty.toLowerCase().includes(q) ||
        app.email.toLowerCase().includes(q) ||
        app.licenseNumber.toLowerCase().includes(q)
    );
  }, [applications, searchQuery]);

  const counts = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    for (const app of applications) {
      if (app.status === "pending") pending++;
      else if (app.status === "approved") approved++;
      else if (app.status === "rejected") rejected++;
    }
    return { pending, approved, rejected, total: applications.length };
  }, [applications]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 space-y-8">
      {/* Admin Console Header */}
      <div className="rounded-3xl border border-purple-100 bg-gradient-to-br from-slate-900 via-purple-950 to-slate-900 p-6 sm:p-8 text-white shadow-lg">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-purple-800/60 px-3 py-1 text-xs font-semibold text-purple-200 backdrop-blur">
              <ShieldCheck className="h-3.5 w-3.5 text-purple-300" />
              Administrative Verification Console
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Physician Credential Verification
            </h1>
            <p className="text-slate-300 text-sm max-w-xl">
              Verify medical council licenses, registration numbers, and practice credentials before activating public bookings.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void retryLoad()}
              disabled={loading}
              className="bg-white/10 text-white border-white/20 hover:bg-white/20 text-xs"
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh Records
            </Button>
          </div>
        </div>
      </div>

      {/* KPI Status Filter Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => setStatusFilter("all")}
          className={`rounded-2xl border p-4 text-left transition ${
            statusFilter === "all" ? "border-purple-600 bg-purple-50/50 ring-2 ring-purple-600/20" : "border-slate-200 bg-white hover:border-slate-300"
          }`}
        >
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Records</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{counts.total}</p>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter("pending")}
          className={`rounded-2xl border p-4 text-left transition ${
            statusFilter === "pending" ? "border-amber-600 bg-amber-50/50 ring-2 ring-amber-600/20" : "border-slate-200 bg-white hover:border-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-amber-700 uppercase tracking-wider">Pending Review</p>
            {counts.pending > 0 && <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />}
          </div>
          <p className="mt-1 text-2xl font-bold text-amber-900">{counts.pending}</p>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter("approved")}
          className={`rounded-2xl border p-4 text-left transition ${
            statusFilter === "approved" ? "border-emerald-600 bg-emerald-50/50 ring-2 ring-emerald-600/20" : "border-slate-200 bg-white hover:border-slate-300"
          }`}
        >
          <p className="text-xs font-medium text-emerald-700 uppercase tracking-wider">Approved & Verified</p>
          <p className="mt-1 text-2xl font-bold text-emerald-900">{counts.approved}</p>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter("rejected")}
          className={`rounded-2xl border p-4 text-left transition ${
            statusFilter === "rejected" ? "border-slate-600 bg-slate-100 ring-2 ring-slate-400/20" : "border-slate-200 bg-white hover:border-slate-300"
          }`}
        >
          <p className="text-xs font-medium text-slate-600 uppercase tracking-wider">Deactivated / Rejected</p>
          <p className="mt-1 text-2xl font-bold text-slate-700">{counts.rejected}</p>
        </button>
      </div>

      {notice && (
        <div role="status" className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-xs font-semibold text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {actionError && (
        <div role="alert" className="rounded-2xl bg-red-50 border border-red-200 p-4 text-xs font-semibold text-red-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Search Input Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by physician name, specialty, license number or email…"
            className="pl-10 text-xs bg-white"
          />
        </div>
      </div>

      {loading && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
          <RefreshCw className="h-5 w-5 text-purple-700 animate-spin mx-auto mb-2" />
          Loading physician records…
        </div>
      )}

      {!loading && loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6">
          <p role="alert" className="text-xs text-red-700 font-medium">{loadError}</p>
          <Button type="button" variant="outline" className="mt-4 text-xs" onClick={() => void retryLoad()}>
            Try again
          </Button>
        </div>
      )}

      {!loading && !loadError && applications.length === 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm font-bold text-slate-900">No doctor records found</p>
          <p className="text-xs text-slate-500 mt-1">
            There are currently no doctor profiles matching the selected filter.
          </p>
        </div>
      )}

      {!loading && !loadError && filteredApplications.length > 0 && (
        <section aria-label="Doctor applications" className="grid gap-6">
          {filteredApplications.map((application) => {
            const busy = activeAction?.id === application.id;
            const isRejectPromptOpen = promptRejectApp?.id === application.id;

            return (
              <Card key={application.id} className="border-slate-200 shadow-xs">
                <CardHeader className="pb-3 border-b border-slate-100">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div className="flex items-start gap-4">
                      {application.profilePhotoUrl ? (
                        <img
                          src={application.profilePhotoUrl}
                          alt={`${application.name} profile photo`}
                          className="h-14 w-14 rounded-2xl object-cover border border-slate-200 flex-shrink-0"
                        />
                      ) : (
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-purple-50 text-purple-700 font-bold border border-purple-200">
                          {application.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <CardTitle className="text-lg font-bold text-slate-900">
                          {application.name}
                        </CardTitle>
                        <CardDescription className="text-xs text-slate-500">
                          {application.email} · Submitted on {new Date(application.submittedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                        </CardDescription>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {application.status === "approved" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 border border-emerald-200">
                          <ShieldCheck className="h-3 w-3 text-emerald-600" />
                          Verified Doctor
                        </span>
                      ) : application.status === "rejected" ? (
                        <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-800 border border-red-200">
                          Rejected / Unapproved
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 border border-amber-200">
                          Pending Verification
                        </span>
                      )}

                      {application.appointmentCount != null && application.appointmentCount > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-800 border border-blue-200">
                          <Calendar className="h-3 w-3" />
                          {application.appointmentCount} Appointment{application.appointmentCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="pt-4 space-y-4">
                  {/* Rejection Reason display if rejected */}
                  {application.status === "rejected" && application.rejectionReason && (
                    <div className="rounded-xl border border-red-200 bg-red-50/70 p-3 text-xs text-red-900">
                      <span className="font-bold">Rejection reason recorded:</span> {application.rejectionReason}
                    </div>
                  )}

                  {/* Medical Credential Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50/80 p-3.5 rounded-2xl border border-slate-100 text-xs">
                    <div>
                      <span className="text-slate-400 font-medium block">Specialty</span>
                      <span className="font-bold text-slate-800">{application.specialty}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-medium block">Registration / Council</span>
                      <span className="font-bold text-slate-800">{application.licenseRegion}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-medium block">License Number</span>
                      <span className="font-mono font-bold text-slate-900 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                        {application.licenseNumber}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-medium block">Experience</span>
                      <span className="font-bold text-slate-800">{application.yearsOfExperience ?? 0} Years</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-slate-600">
                    <div>
                      <span className="font-semibold text-slate-700">Qualifications: </span>
                      <span>{application.qualifications || "Not specified"}</span>
                    </div>
                    <div>
                      <span className="font-semibold text-slate-700">Consultation Fee: </span>
                      <span>₹{application.consultationFeeInr?.toLocaleString("en-IN") ?? 500}</span>
                    </div>
                    <div>
                      <span className="font-semibold text-slate-700">Contact Phone: </span>
                      <span>{application.phone || "Not specified"}</span>
                    </div>
                  </div>

                  {(application.clinicName || application.clinicAddress) && (
                    <div className="text-xs text-slate-600 border-t border-slate-100 pt-3">
                      <span className="font-semibold text-slate-700">Practice Location: </span>
                      <span>{application.clinicName ? `${application.clinicName} — ` : ""}{application.clinicAddress || ""}</span>
                    </div>
                  )}

                  {application.bio && (
                    <p className="text-xs text-slate-500 bg-white p-2.5 rounded-xl border border-slate-100 italic">
                      &ldquo;{application.bio}&rdquo;
                    </p>
                  )}

                  {/* Inline Rejection Reason Form */}
                  {isRejectPromptOpen && (
                    <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-red-950 uppercase tracking-wider">
                          Rejection Reason (Required — shown to doctor)
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setPromptRejectApp(null);
                            setRejectionReasonInput("");
                            setRejectReasonError("");
                          }}
                          className="text-xs text-slate-500 hover:text-slate-800"
                        >
                          Cancel
                        </button>
                      </div>
                      <Input
                        placeholder="e.g. Medical registration number not found on state council records; upload valid council certificate"
                        value={rejectionReasonInput}
                        onChange={(e) => setRejectionReasonInput(e.target.value)}
                        className="text-xs bg-white border-red-200"
                        disabled={busy}
                      />
                      {rejectReasonError && <p className="text-xs text-red-600 font-semibold">{rejectReasonError}</p>}
                      <div className="flex justify-end gap-2 pt-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => {
                            setPromptRejectApp(null);
                            setRejectionReasonInput("");
                            setRejectReasonError("");
                          }}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="bg-red-700 hover:bg-red-800 text-white text-xs font-semibold"
                          disabled={busy}
                          onClick={() => {
                            if (rejectionReasonInput.trim().length < 5) {
                              setRejectReasonError("Please enter a clear rejection reason (minimum 5 characters).");
                              return;
                            }
                            setRejectReasonError("");
                            void decide(application, "rejected", rejectionReasonInput.trim());
                            setPromptRejectApp(null);
                            setRejectionReasonInput("");
                          }}
                        >
                          {busy ? "Submitting…" : "Confirm Rejection"}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex flex-wrap items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                    {application.status === "pending" && !isRejectPromptOpen && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          className="bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs"
                          onClick={() => void decide(application, "approved")}
                          disabled={Boolean(activeAction)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                          {busy && activeAction?.action === "approve" ? "Approving…" : "Approve & Verify Doctor"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 text-xs"
                          onClick={() => {
                            setPromptRejectApp(application);
                            setRejectionReasonInput("");
                            setRejectReasonError("");
                          }}
                          disabled={Boolean(activeAction)}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1.5" />
                          Reject with Reason
                        </Button>
                      </>
                    )}

                    {application.status === "approved" && !isRejectPromptOpen && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="border-amber-300 text-amber-800 hover:bg-amber-50 font-semibold text-xs"
                          onClick={() => {
                            setPromptRejectApp(application);
                            setRejectionReasonInput("Deactivated by administrator");
                            setRejectReasonError("");
                          }}
                          disabled={Boolean(activeAction)}
                          title="Safely deactivates doctor from new bookings while preserving medical history"
                        >
                          <UserX className="h-3.5 w-3.5 mr-1.5 text-amber-600" />
                          {busy && activeAction?.action === "reject" ? "Deactivating…" : "Deactivate Doctor"}
                        </Button>

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 text-xs"
                          onClick={() => void handleDelete(application)}
                          disabled={Boolean(activeAction)}
                          title="Permanent deletion (blocked if appointments exist)"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                          {busy && activeAction?.action === "delete" ? "Deleting…" : "Delete Doctor"}
                        </Button>
                      </>
                    )}

                    {application.status === "rejected" && !isRejectPromptOpen && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          className="bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs"
                          onClick={() => void decide(application, "approved")}
                          disabled={Boolean(activeAction)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                          {busy && activeAction?.action === "approve" ? "Re-activating…" : "Re-approve Doctor"}
                        </Button>

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 text-xs"
                          onClick={() => void handleDelete(application)}
                          disabled={Boolean(activeAction)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                          {busy && activeAction?.action === "delete" ? "Deleting…" : "Delete Doctor"}
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>
      )}
    </div>
  );
}
