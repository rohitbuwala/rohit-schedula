"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Menu, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function SiteHeader() {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
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
  return (
    <header className="border-b border-slate-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 font-bold tracking-tight text-slate-900 group">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-teal-700 to-cyan-600 text-white shadow-sm shadow-teal-700/20 group-hover:scale-105 transition-transform">
            <Activity className="h-5 w-5" />
          </div>
          <span className="text-xl font-bold tracking-tight text-slate-900">
            Med<span className="text-teal-700">rella</span>
          </span>
        </Link>
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 md:hidden"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={menuOpen}
          aria-controls="site-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <nav
          id="site-navigation"
          className={`${menuOpen ? "flex" : "hidden"} w-full flex-col items-stretch gap-1 border-t border-slate-100 pt-2 md:flex md:w-auto md:flex-row md:items-center md:gap-2 md:border-0 md:pt-0`}
          aria-label="Main navigation"
        >
          {!isPending && (session ? (
            <>
              {"role" in session.user && session.user.role === "patient" && (
                <Link onClick={() => setMenuOpen(false)} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-teal-700 transition md:hover:bg-transparent" href="/patient/profile">
                  Profile
                </Link>
              )}
              <Link onClick={() => setMenuOpen(false)} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-teal-700 transition md:hover:bg-transparent" href="/dashboard">
                Dashboard
              </Link>
              <Button variant="outline" size="sm" className="w-full md:w-auto" onClick={logout} disabled={loggingOut}>
                {loggingOut ? "Logging out…" : "Log out"}
              </Button>
              {logoutError && <span role="alert" className="text-sm text-red-700">{logoutError}</span>}
            </>
          ) : (
            <>
              <Link onClick={() => setMenuOpen(false)} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-teal-700 transition md:hover:bg-transparent" href="/login">
                Log in
              </Link>
              <Link onClick={() => setMenuOpen(false)} href="/signup" className="rounded-lg bg-teal-700 px-3.5 py-2 text-center text-sm font-semibold text-white hover:bg-teal-800 transition shadow-sm">
                Get started
              </Link>
            </>
          ))}
        </nav>
      </div>
    </header>
  );
}
