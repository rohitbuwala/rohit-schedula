import { redirect } from "next/navigation";
import { PatientProfile } from "@/components/patient-profile";
import { SiteHeader } from "@/components/site-header";
import { dashboardPath, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function PatientProfilePage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "patient") redirect(dashboardPath(session.user.role));
  return <><SiteHeader /><PatientProfile /></>;
}
