"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function SiteHeader() {
  const router = useRouter();
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const { data: session, isPending } = authClient.useSession();
  async function logout() {
    setLogoutError("");
    setLoggingOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setLogoutError("Could not log out. Please try again.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setLogoutError("Could not log out. Please try again.");
    } finally {
      setLoggingOut(false);
    }
  }
  return <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
    <Link href="/" className="text-xl font-bold tracking-tight text-teal-800">Schedula</Link>
    <nav className="flex items-center gap-2" aria-label="Main navigation">
      {!isPending && (session ? <>{"role" in session.user && session.user.role === "patient" && <Link className="px-3 py-2 text-sm font-medium text-slate-700 hover:text-teal-800" href="/patient/profile">Profile</Link>}<Link className="px-3 py-2 text-sm font-medium text-slate-700 hover:text-teal-800" href="/dashboard">Dashboard</Link><Button variant="outline" size="sm" onClick={logout} disabled={loggingOut}>{loggingOut ? "Logging out…" : "Log out"}</Button>{logoutError && <span role="alert" className="text-sm text-red-700">{logoutError}</span>}</> : <><Link className="px-3 py-2 text-sm font-medium text-slate-700" href="/login">Log in</Link><Link href="/signup" className="rounded-lg bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800">Create account</Link></>)}
    </nav>
  </header>;
}
