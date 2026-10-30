import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { SiteHeader } from "@/components/site-header";
import { dashboardPath, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function SignupPage() {
  const session = await getVerifiedSession();
  if (session) redirect(dashboardPath(session.user.role));
  return <><SiteHeader /><main className="flex flex-1 items-center justify-center px-5 py-12"><AuthForm mode="signup" /></main></>;
}
