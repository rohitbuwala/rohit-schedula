import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { StaffQueueDashboard } from "@/components/staff-queue-dashboard";
import { StaffAccessGate } from "@/components/staff-registration";
import { dashboardPath, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function StaffDashboardPage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "staff") redirect(dashboardPath(session.user.role));
  return <AppShell role="staff" userName={session.user.name}><StaffAccessGate><StaffQueueDashboard /></StaffAccessGate></AppShell>;
}
