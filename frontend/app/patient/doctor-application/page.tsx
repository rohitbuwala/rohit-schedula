import { redirect } from "next/navigation";
import { DoctorApplication } from "@/components/doctor-application";
import { SiteHeader } from "@/components/site-header";
import { dashboardPath, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function DoctorApplicationPage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "patient") redirect(dashboardPath(session.user.role));
  return <><SiteHeader /><DoctorApplication /></>;
}
