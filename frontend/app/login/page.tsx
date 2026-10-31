import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { SiteHeader } from "@/components/site-header";
import { getPostLoginRedirect, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function LoginPage() {
  const session = await getVerifiedSession();
  if (session) {
    const destination = await getPostLoginRedirect();
    redirect(destination);
  }

  return (
    <>
      <SiteHeader />
      <main className="flex flex-1 items-center justify-center px-5 py-12">
        <AuthForm mode="login" />
      </main>
    </>
  );
}
