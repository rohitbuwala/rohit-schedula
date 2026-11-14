import { redirect } from "next/navigation";
import { canShowAssistant, getVerifiedSession, dashboardPath } from "@/lib/auth-server";
import { PatientOverview } from "@/components/patient-overview";
import { AppShell } from "@/components/app-shell";
import { AssistantPanel } from "@/components/assistant/assistant-panel";

export const instant = false;

export default async function PatientDashboard() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "patient") redirect(dashboardPath(session.user.role));
  const showAssistant = await canShowAssistant("patient");

  return (
    <AppShell role="patient" userName={session.user.name}>
      <PatientOverview name={session.user.name}
        assistant={showAssistant ? <AssistantPanel key={session.user.id} role="patient" patientId={session.user.id} /> : null} />
    </AppShell>
  );
}
