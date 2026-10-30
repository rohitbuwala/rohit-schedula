import { redirect } from "next/navigation";
import { DoctorApplication } from "@/components/doctor-application";
import { AppShell } from "@/components/app-shell";
import { dashboardPath, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function DoctorApplicationPage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "patient") redirect(dashboardPath(session.user.role));

  return (
    <AppShell role="patient" userName={session.user.name}>
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8">
        <DoctorApplication />
      </div>
    </AppShell>
  );
}
