import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { StaffRegistrationForm } from "@/components/staff-registration";
import { getPostLoginRedirect, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;
export default async function StaffSignupPage() {
  if (await getVerifiedSession()) redirect(await getPostLoginRedirect());
  return <><SiteHeader /><main className="flex flex-1 items-center justify-center px-4 py-12"><StaffRegistrationForm /></main></>;
}
