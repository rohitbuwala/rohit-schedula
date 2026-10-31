import { redirect } from "next/navigation";
import { getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function DoctorOnboardingPage() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  redirect("/doctor/dashboard");
}
