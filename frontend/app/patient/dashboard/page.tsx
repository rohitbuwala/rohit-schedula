import { redirect } from "next/navigation";
import { getVerifiedSession, dashboardPath } from "@/lib/auth-server";
import { PatientBooking } from "@/components/patient-booking";
import { SiteHeader } from "@/components/site-header";
import { DoctorApplicationLink } from "@/components/doctor-application-link";

export const instant = false;

export default async function PatientDashboard() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "patient") redirect(dashboardPath(session.user.role));
  return <><SiteHeader /><PatientBooking name={session.user.name} /><DoctorApplicationLink /></>;
}
