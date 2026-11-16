import { redirect } from "next/navigation";
import { AdminDashboard } from "@/components/admin-dashboard";
import { AppShell } from "@/components/app-shell";
import { dashboardPath, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function AdminLandingPage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "admin") {
    redirect(dashboardPath(session.user.role));
  }

  return (
    <AppShell role="admin" userName={session.user.name}>
      <AdminDashboard />
    </AppShell>
  );
}
