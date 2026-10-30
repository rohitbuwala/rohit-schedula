import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { AdminDoctorApplications } from "@/components/admin-doctor-applications";
import { getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function AdminLandingPage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "admin") redirect(session.user.role === "doctor" ? "/doctor/dashboard" : "/patient/dashboard");
  return <><SiteHeader /><AdminDoctorApplications /></>;
}
