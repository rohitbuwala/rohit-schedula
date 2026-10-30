import { redirect } from "next/navigation";
import { getVerifiedSession, dashboardPath } from "@/lib/auth-server";
import { PatientOverview } from "@/components/patient-overview";
import { AppShell } from "@/components/app-shell";

export const instant = false;

export default async function PatientDashboard() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "patient") redirect(dashboardPath(session.user.role));

  return (
    <AppShell role="patient" userName={session.user.name}>
      <PatientOverview name={session.user.name} />
    </AppShell>
  );
}
