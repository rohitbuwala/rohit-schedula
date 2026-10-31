import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Stethoscope, User, ShieldCheck } from "lucide-react";
import { getVerifiedSession } from "@/lib/auth-server";
import { parseDoctorApplicationResponseBody } from "@/lib/doctor-application-response";
import { DoctorAppointments } from "@/components/doctor-appointments";
import { DoctorPendingDashboard } from "@/components/doctor-pending-dashboard";
import { AppShell } from "@/components/app-shell";

export const instant = false;

const authUrl = (process.env.NEXT_PUBLIC_AUTH_URL ?? "http://localhost:5000").replace(/\/+$/, "");

export default async function DoctorDashboard() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");

  if (session.user.role === "admin") redirect("/admin");

  if (session.user.role === "doctor") {
    return (
      <AppShell role="doctor" userName={session.user.name}>
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 space-y-8">
          {/* Approved Physician Header Banner */}
          <div className="rounded-3xl border border-blue-100 bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 p-6 sm:p-8 text-white shadow-lg">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-blue-800/60 px-3 py-1 text-xs font-semibold text-blue-200 backdrop-blur">
                    <Stethoscope className="h-3.5 w-3.5 text-blue-300" />
                    Physician Consultation Workspace
                  </div>
                  <div className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-300 border border-emerald-500/40 backdrop-blur">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                    Verified Doctor
                  </div>
                </div>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                  Dr. {session.user.name}
                </h1>
                <p className="text-slate-300 text-sm max-w-xl">
                  Review your daily patient queue, conduct and conclude consultations, and keep your clinical practice profile updated.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Link
                  href="/doctor/profile"
                  className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-bold text-slate-900 hover:bg-slate-100 transition shadow-sm"
                >
                  <User className="h-4 w-4 text-teal-700" />
                  Manage Practice Profile
                </Link>
              </div>
            </div>
          </div>

          {/* Doctor Appointments Queue & Workspace */}
          <DoctorAppointments />
        </div>
      </AppShell>
    );
  }

  // If role is patient, check if they are a doctor applicant awaiting or undergoing verification
  const rawCookie = (await headers()).get("cookie");
  let applicant = null;
  try {
    const res = await fetch(`${authUrl}/api/doctor-applications/me`, {
      headers: { cookie: rawCookie ?? "" },
      cache: "no-store",
    });
    if (res.ok) {
      const text = await res.text();
      applicant = parseDoctorApplicationResponseBody(text);
    }
  } catch {
    applicant = null;
  }

  if (!applicant) {
    redirect("/patient/dashboard");
  }

  return (
    <AppShell role="doctor" userName={session.user.name}>
      <DoctorPendingDashboard applicant={applicant} userName={session.user.name} />
    </AppShell>
  );
}
