import { redirect } from "next/navigation";
import Link from "next/link";
import { Stethoscope, User } from "lucide-react";
import { getVerifiedSession, dashboardPath } from "@/lib/auth-server";
import { DoctorAppointments } from "@/components/doctor-appointments";
import { AppShell } from "@/components/app-shell";

export const instant = false;

export default async function DoctorDashboard() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "doctor") redirect(dashboardPath(session.user.role));

  return (
    <AppShell role="doctor" userName={session.user.name}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 space-y-8">
        {/* Physician Header Banner */}
        <div className="rounded-3xl border border-blue-100 bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 p-6 sm:p-8 text-white shadow-lg">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full bg-blue-800/60 px-3 py-1 text-xs font-semibold text-blue-200 backdrop-blur">
                <Stethoscope className="h-3.5 w-3.5 text-blue-300" />
                Physician Consultation Workspace
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
