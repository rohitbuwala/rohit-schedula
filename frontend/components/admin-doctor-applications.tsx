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
    setLoading(true);
    setLoadError("");
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

  async function decide(application: PendingApplication, decision: "approved" | "rejected") {
    setActionError("");
    setNotice("");
    setActiveAction({ id: application.id, action: decision === "approved" ? "approve" : "reject" });
    try {
      const response = await fetch(
        `${backendUrl}/api/admin/doctor-applications/${encodeURIComponent(application.id)}/decision`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        }
      );
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("Administrator access is required to review applications.");
      if (response.status === 404 || response.status === 409) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.message || "Could not update doctor application.");
      }
      if (!response.ok) throw new Error("Could not update the application. Please try again.");

      const actionVerb = decision === "approved"
        ? (application.status === "rejected" ? "reactivated and approved" : "approved")
        : "deactivated (safe unapproval)";

      setNotice(`${application.name} was successfully ${actionVerb}. Appointment history is preserved.`);
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
              Medrella Medical Board Oversight
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Doctor Credential Verification & Management
            </h1>
            <p className="text-purple-100/90 text-sm max-w-xl">
              Inspect medical credentials, safely deactivate doctors from new bookings to preserve medical appointment history, or delete eligible profiles.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 bg-white/10 backdrop-blur rounded-2xl p-3 border border-white/15 text-center">
            <div className="px-3 py-1 border-r border-white/15">
              <p className="text-xl font-extrabold text-amber-300">{counts.pending}</p>
              <p className="text-[10px] font-medium text-purple-200 uppercase tracking-wider">Pending</p>
            </div>
            <div className="px-3 py-1 border-r border-white/15">
              <p className="text-xl font-extrabold text-emerald-300">{counts.approved}</p>
              <p className="text-[10px] font-medium text-purple-200 uppercase tracking-wider">Approved</p>
            </div>
            <div className="px-3 py-1">
              <p className="text-xl font-extrabold text-slate-300">{counts.rejected}</p>
              <p className="text-[10px] font-medium text-purple-200 uppercase tracking-wider">Deactivated</p>
            </div>
          </div>
        </div>
      </div>

      {/* Action feedback */}
      {actionError && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-xs font-medium text-red-700 border border-red-200 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 mt-0.5" />
          <span>{actionError}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-xl bg-emerald-50 p-4 text-xs font-medium text-emerald-800 border border-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 mt-0.5" />
          <span>{notice}</span>
        </div>
      )}

      {/* Filter and search controls */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "pending", "approved", "rejected"] as const).map((tab) => {
            const label = tab === "all" ? "All Profiles" : tab === "pending" ? "Pending" : tab === "approved" ? "Approved Doctors" : "Deactivated";
            const active = statusFilter === tab;
            return (
              <Button
                key={tab}
                type="button"
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(tab)}
                className={`text-xs h-8 ${active ? "bg-purple-900 hover:bg-purple-800 text-white" : "border-slate-200 text-slate-700"}`}
              >
                {label}
              </Button>
            );
          })}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {statusFilter === "all" ? "All Doctor Profiles" : statusFilter === "pending" ? "Pending Reviews" : statusFilter === "approved" ? "Approved Active Doctors" : "Deactivated / Rejected Doctors"} ({filteredApplications.length})
            </h2>
            <p className="text-xs text-slate-500">
              Manage physician credentials, active practice statuses, and appointments.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search applicant or license…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-white text-xs h-9"
              />
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void retryLoad()}
              disabled={loading}
              className="text-xs h-9"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
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
                          {application.email} · Submitted on {new Date(application.submittedAt).toLocaleDateString()}
                        </CardDescription>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {application.status === "approved" ? (
                        <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 border border-emerald-200">
                          Approved Active Doctor
                        </span>
                      ) : application.status === "rejected" ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 border border-slate-200">
                          Deactivated / Rejected
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 border border-amber-200">
                          Pending Approval
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
                  <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 text-xs">
                    <Detail label="Specialty" value={application.specialty} />
                    <Detail label="License Details" value={`${application.licenseNumber} (${application.licenseRegion})`} />
                    {application.phone && <Detail label="Contact Phone" value={application.phone} />}
                    {application.qualifications && <Detail label="Qualifications" value={application.qualifications} />}
                    {application.yearsOfExperience != null && (
                      <Detail label="Experience" value={`${application.yearsOfExperience} years`} />
                    )}
                    {application.consultationFeeInr != null && (
                      <Detail label="Consultation Fee" value={`₹${application.consultationFeeInr.toLocaleString("en-IN")}`} />
                    )}
                    {application.clinicName && <Detail label="Clinic / Hospital" value={application.clinicName} />}
                    {application.clinicAddress && (
                      <div className="sm:col-span-2">
                        <Detail label="Clinic Address" value={application.clinicAddress} />
                      </div>
                    )}
                    <div className="sm:col-span-2">
                      <Detail label="Professional Bio" value={application.bio || "No bio provided."} />
                    </div>
                  </dl>

                  <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-slate-100">
                    {application.status === "pending" && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          className="bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs"
                          onClick={() => void decide(application, "approved")}
                          disabled={Boolean(activeAction)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                          {busy && activeAction?.action === "approve" ? "Approving…" : "Approve Application"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 text-xs"
                          onClick={() => void decide(application, "rejected")}
                          disabled={Boolean(activeAction)}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1.5" />
                          {busy && activeAction?.action === "reject" ? "Rejecting…" : "Reject Application"}
                        </Button>
                      </>
                    )}

                    {application.status === "approved" && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="border-amber-300 text-amber-800 hover:bg-amber-50 font-semibold text-xs"
                          onClick={() => void decide(application, "rejected")}
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

                    {application.status === "rejected" && (
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-slate-900">{value}</dd>
    </div>
  );
}
