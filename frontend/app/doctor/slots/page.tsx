import { redirect } from "next/navigation";
import { DoctorScheduleManager } from "@/components/doctor-schedule-manager";
import { AppShell } from "@/components/app-shell";
import { getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function DoctorSlotsPage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "doctor") {
    redirect(session.user.role === "admin" ? "/admin" : "/doctor/dashboard");
  }

  return (
    <AppShell role="doctor" userName={session.user.name}>
      <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 sm:py-10 lg:px-8">
        <header className="mb-7">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-800">Practice management</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Schedule &amp; availability</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Configure your weekly hours and date-specific availability. Upcoming booked times reflect current appointments.</p>
        </header>
        <DoctorScheduleManager />
      </main>
    </AppShell>
  );
}
