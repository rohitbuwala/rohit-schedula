import { redirect } from "next/navigation";
import { getVerifiedSession, dashboardPath } from "@/lib/auth-server";

export const instant = false;

export default async function DashboardRedirect() {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  redirect(dashboardPath(session.user.role));
}
