import { redirect } from "next/navigation";
import { AdminDoctorApplications } from "@/components/admin-doctor-applications";
import { AppShell } from "@/components/app-shell";
import { getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function AdminLandingPage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "admin") {
    redirect(session.user.role === "doctor" ? "/doctor/dashboard" : "/patient/dashboard");
  }

  return (
    <AppShell role="admin" userName={session.user.name}>
      <AdminDoctorApplications />
    </AppShell>
  );
}
