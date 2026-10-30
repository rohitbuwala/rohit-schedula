import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { DoctorSignupForm } from "@/components/doctor-signup-form";
import { getPostLoginRedirect, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function DoctorSignupPage() {
  const session = await getVerifiedSession();
  if (session) {
    const destination = await getPostLoginRedirect();
    redirect(destination);
  }

  return (
    <>
      <SiteHeader />
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
        <DoctorSignupForm />
      </main>
    </>
  );
}
