"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { backendUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const pendingApplicationSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  name: z.string(),
  email: z.email(),
  specialty: z.string(),
  licenseRegion: z.string(),
  licenseNumber: z.string(),
  bio: z.string().nullable(),
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

  const loadApplications = useCallback(async () => {
    const response = await fetch(`${backendUrl}/api/admin/doctor-applications`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(response.status === 401
        ? "Your session expired. Log in again."
        : response.status === 403
          ? "Administrator access is required to review applications."
          : "Could not load doctor applications.");
    }
    const parsed = pendingApplicationsResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Applications returned an unexpected response.");
    return parsed.data.filter((application) => application.status === "pending");
  }, []);

  useEffect(() => {
    let active = true;
    loadApplications().then((result) => {
      if (active) setApplications(result);
    }).catch((cause: unknown) => {
      if (active) setLoadError(cause instanceof Error ? cause.message : "Could not load doctor applications.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
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
      const response = await fetch(`${backendUrl}/api/admin/doctor-applications/${encodeURIComponent(application.id)}/decision`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("Administrator access is required to review applications.");
      if (response.status === 404 || response.status === 409) {
        throw new Error("This application is no longer pending. Refresh the list and try again.");
      }
      if (!response.ok) throw new Error("Could not update the application. Please try again.");
      setApplications((current) => current.filter((item) => item.id !== application.id));
      setNotice(`${application.name}'s application was ${decision}.`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update the application. Please try again.");
    } finally {
      setActiveAction(null);
    }
  }

  return <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
    <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">Administration</p>
    <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Doctor application review</h1>
    <p className="mt-3 text-slate-600">Review submitted credentials and approve or reject each pending application.</p>
    {actionError && <p role="alert" className="mt-6 rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
    {notice && <p role="status" className="mt-6 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
    {loading && <p role="status" className="mt-8 text-sm text-slate-600">Loading pending applications…</p>}
    {!loading && loadError && <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-5">
      <p role="alert" className="text-sm text-red-700">{loadError}</p>
      <Button type="button" variant="outline" className="mt-4" onClick={() => void retryLoad()}>Try again</Button>
    </div>}
    {!loading && !loadError && applications.length === 0 && <p className="mt-8 rounded-xl border border-slate-200 p-5 text-sm text-slate-600">There are no pending doctor applications.</p>}
    {!loading && !loadError && applications.length > 0 && <section aria-label="Pending doctor applications" className="mt-8 grid gap-5">
      {applications.map((application) => {
        const busy = activeAction?.id === application.id;
        return <Card key={application.id}>
          <CardHeader>
            <CardTitle>{application.name}</CardTitle>
            <CardDescription>{application.email} · Submitted {new Date(application.submittedAt).toLocaleString()}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Detail label="Specialty" value={application.specialty} />
              <Detail label="License region" value={application.licenseRegion} />
              <Detail label="License number" value={application.licenseNumber} />
              <Detail label="Applicant user ID" value={application.userId} />
              <div className="sm:col-span-2"><Detail label="Professional bio" value={application.bio || "No bio provided."} /></div>
            </dl>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button type="button" onClick={() => void decide(application, "approved")} disabled={Boolean(activeAction)}>
                {busy && activeAction?.decision === "approved" ? "Approving…" : "Approve"}
              </Button>
              <Button type="button" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" onClick={() => void decide(application, "rejected")} disabled={Boolean(activeAction)}>
                {busy && activeAction?.decision === "rejected" ? "Rejecting…" : "Reject"}
              </Button>
            </div>
          </CardContent>
        </Card>;
      })}
    </section>}
  </main>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 break-words text-sm text-slate-900">{value}</dd></div>;
}
