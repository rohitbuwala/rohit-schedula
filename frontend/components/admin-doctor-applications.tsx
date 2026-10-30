"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  CheckCircle2,
  RefreshCw,
  Search,
  ShieldCheck,
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
});
const pendingApplicationsResponseSchema = z.array(pendingApplicationSchema);
type PendingApplication = z.infer<typeof pendingApplicationSchema>;

export function AdminDoctorApplications() {
  const [applications, setApplications] = useState<PendingApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeAction, setActiveAction] = useState<{ id: string; decision: "approved" | "rejected" } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const loadApplications = useCallback(async () => {
    const response = await fetch(`${backendUrl}/api/admin/doctor-applications`, {
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
    return parsed.data.filter((application) => application.status === "pending");
  }, []);

  useEffect(() => {
    let active = true;
    loadApplications()
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
  }, [loadApplications]);

  async function retryLoad() {
    setLoading(true);
    setLoadError("");
    try {
      setApplications(await loadApplications());
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Could not load doctor applications.");
    } finally {
      setLoading(false);
    }
  }

  async function decide(application: PendingApplication, decision: "approved" | "rejected") {
    setActionError("");
    setNotice("");
    setActiveAction({ id: application.id, decision });
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
        throw new Error("This application is no longer pending. Refresh the list and try again.");
      }
      if (!response.ok) throw new Error("Could not update the application. Please try again.");
      setApplications((current) => current.filter((item) => item.id !== application.id));
      setNotice(`${application.name}'s application was successfully marked as ${decision}.`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update the application. Please try again.");
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
              Doctor Credential Verification
            </h1>
            <p className="text-purple-100/90 text-sm max-w-xl">
              Inspect medical registrations, license regions, qualifications, and consultation details before authorizing physician accounts.
            </p>
          </div>

          <div className="flex items-center gap-4 bg-white/10 backdrop-blur rounded-2xl p-4 border border-white/15">
            <div className="text-center px-2">
              <p className="text-2xl font-extrabold text-white">{applications.length}</p>
              <p className="text-[11px] font-medium text-purple-200 uppercase tracking-wider">
                Pending Reviews
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Action feedback */}
      {actionError && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-xs font-medium text-red-700 border border-red-200">
          {actionError}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-xl bg-emerald-50 p-4 text-xs font-medium text-emerald-800 border border-emerald-200">
          {notice}
        </div>
      )}

      {/* List controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            Pending Applications ({applications.length})
          </h2>
          <p className="text-xs text-slate-500">
            All submitted doctor credentials awaiting verification.
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

      {loading && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
          <RefreshCw className="h-5 w-5 text-purple-700 animate-spin mx-auto mb-2" />
          Loading pending physician applications…
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
          <p className="text-sm font-bold text-slate-900">All applications processed</p>
          <p className="text-xs text-slate-500 mt-1">
            There are currently no pending doctor credential submissions requiring review.
          </p>
        </div>
      )}

      {!loading && !loadError && filteredApplications.length > 0 && (
        <section aria-label="Pending doctor applications" className="grid gap-6">
          {filteredApplications.map((application) => {
            const busy = activeAction?.id === application.id;
            return (
              <Card key={application.id} className="border-slate-200 shadow-xs">
                <CardHeader className="pb-3 border-b border-slate-100">
                  <div className="flex items-start justify-between gap-4">
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
                    <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 border border-amber-200">
                      Pending Approval
                    </span>
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

                  <div className="flex items-center gap-3 pt-3 border-t border-slate-100">
                    <Button
                      type="button"
                      size="sm"
                      className="bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs"
                      onClick={() => void decide(application, "approved")}
                      disabled={Boolean(activeAction)}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                      {busy && activeAction?.decision === "approved" ? "Approving…" : "Approve Application"}
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
                      {busy && activeAction?.decision === "rejected" ? "Rejecting…" : "Reject Application"}
                    </Button>
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
