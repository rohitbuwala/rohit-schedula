import { redirect } from "next/navigation";
import { DashboardPage } from "@/components/dashboard-page";
import { getVerifiedSession, dashboardPath } from "@/lib/auth-server";

export const instant = false;

export default async function DoctorDashboard() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "doctor") redirect(dashboardPath(session.user.role));
  return <DashboardPage kind="Doctor" name={session.user.name} />;
}
