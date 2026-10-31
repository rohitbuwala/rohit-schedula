import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { DoctorApplicationStatus } from "@/components/doctor-application-status";
import { getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function DoctorApplicationStatusPage() {
  const session = await getVerifiedSession();
  if (!session) {
    redirect("/login");
  }

  if (session.user.role === "admin") {
    redirect("/admin");
  }

  if (session.user.role === "doctor") {
    redirect("/doctor/dashboard");
  }

  return (
    <>
      <SiteHeader />
      <main className="flex flex-1 flex-col justify-center py-6">
        <DoctorApplicationStatus />
      </main>
    </>
  );
}
