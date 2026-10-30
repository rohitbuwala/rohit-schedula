import { redirect } from "next/navigation";
import { getVerifiedSession, dashboardPath } from "@/lib/auth-server";
import { DoctorProfileView } from "@/components/doctor-profile-view";
import { AppShell } from "@/components/app-shell";

export const instant = false;

export default async function DoctorProfilePage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "doctor") redirect(dashboardPath(session.user.role));

  return (
    <AppShell role="doctor" userName={session.user.name}>
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 space-y-6">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-teal-700">
            Professional Practice Details
          </span>
          <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Doctor Profile
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Your public-facing profile as seen by patients, plus your verified medical registration credentials.
          </p>
        </div>

        <DoctorProfileView />
      </div>
    </AppShell>
  );
}
