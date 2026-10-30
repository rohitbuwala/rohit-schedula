"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  Calendar,
  LayoutDashboard,
  LogOut,
  Menu,
  ShieldCheck,
  Stethoscope,
  User,
  X,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { NotificationsBell } from "@/components/notifications-bell";

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface AppShellProps {
  role: "patient" | "doctor" | "admin";
  userName: string;
  children: React.ReactNode;
}

export function AppShell({ role, userName, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  async function handleLogout() {
    setLogoutError("");
    setLoggingOut(true);
    try {
      const res = await authClient.signOut();
      if (res.error) {
        setLogoutError("Could not sign out. Please try again.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setLogoutError("Could not sign out. Please try again.");
    } finally {
      setLoggingOut(false);
    }
  }

  const navItems: NavItem[] =
    role === "patient"
      ? [
          { label: "Dashboard Overview", href: "/patient/dashboard", icon: LayoutDashboard },
          { label: "Book Appointment", href: "/patient/book-appointment", icon: Calendar },
          { label: "My Profile", href: "/patient/profile", icon: User },
        ]
      : role === "doctor"
      ? [
          { label: "Doctor Workspace", href: "/doctor/dashboard", icon: LayoutDashboard },
          { label: "Practice Profile", href: "/doctor/profile", icon: Stethoscope },
        ]
      : [
          { label: "Admin Applications", href: "/admin", icon: ShieldCheck },
        ];

  const roleLabels: Record<string, { title: string; badge: string; color: string }> = {
    patient: {
      title: "Patient Portal",
      badge: "Patient",
      color: "bg-teal-50 text-teal-800 border-teal-200",
    },
    doctor: {
      title: "Doctor Workspace",
      badge: "Physician",
      color: "bg-blue-50 text-blue-800 border-blue-200",
    },
    admin: {
      title: "Admin Console",
      badge: "Administrator",
      color: "bg-purple-50 text-purple-800 border-purple-200",
    },
  };

  const currentRoleMeta = roleLabels[role] || roleLabels.patient;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Mobile Header */}
      <header className="md:hidden flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sticky top-0 z-40">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-teal-700 to-cyan-600 text-white">
            <Activity className="h-4 w-4" />
          </div>
          <span className="font-bold text-slate-900">
            Med<span className="text-teal-700">rella</span>
          </span>
        </Link>
        <div className="flex items-center gap-1">
          <NotificationsBell />
          <button
            type="button"
            onClick={() => setMobileOpen(!mobileOpen)}
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-600"
            aria-label="Toggle navigation"
          >
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </header>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <aside className="md:hidden border-b border-slate-200 bg-white px-4 py-4 space-y-4">
          <div className="pb-2 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-900">{userName}</p>
            <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full border ${currentRoleMeta.color}`}>
              {currentRoleMeta.badge}
            </span>
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    active
                      ? "bg-teal-50 text-teal-800 font-semibold"
                      : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="pt-2 border-t border-slate-100">
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              disabled={loggingOut}
              className="w-full justify-start text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
            >
              <LogOut className="h-4 w-4 mr-2" />
              {loggingOut ? "Signing out…" : "Sign out"}
            </Button>
            {logoutError && <p className="text-xs text-red-600 mt-2">{logoutError}</p>}
          </div>
        </aside>
      )}

      {/* Fixed Desktop Sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 h-[100dvh] z-30 flex-col border-r border-slate-200 bg-white px-5 py-6 shrink-0">
        {/* Top: Logo & Portal Info */}
        <div className="shrink-0 mb-6">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-teal-700 to-cyan-600 text-white shadow-sm shadow-teal-700/20 group-hover:scale-105 transition-transform">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <span className="text-xl font-bold tracking-tight text-slate-900">
                Med<span className="text-teal-700">rella</span>
              </span>
              <p className="text-[11px] font-medium tracking-wide uppercase text-slate-400">
                {currentRoleMeta.title}
              </p>
            </div>
          </Link>
        </div>

        {/* Middle: Independently Scrollable Navigation Area */}
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
          <nav className="space-y-1.5" aria-label="Sidebar navigation">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
              Menu
            </p>
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                    active
                      ? "bg-teal-50 text-teal-800 font-semibold shadow-xs"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${active ? "text-teal-700" : "text-slate-400"}`} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom: Pinned User Card & Logout Footer */}
        <div className="shrink-0 pt-4 mt-4 border-t border-slate-100 space-y-4">
          <div className="flex items-center gap-3 px-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700 border border-slate-200">
              {userName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900 truncate">{userName}</p>
              <span className={`inline-block text-[11px] px-2 py-0.5 rounded-full border ${currentRoleMeta.color}`}>
                {currentRoleMeta.badge}
              </span>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleLogout}
            disabled={loggingOut}
            className="w-full justify-center text-slate-700 hover:text-red-700 hover:bg-red-50 hover:border-red-200 transition"
          >
            <LogOut className="h-4 w-4 mr-2" />
            {loggingOut ? "Signing out…" : "Sign out"}
          </Button>
          {logoutError && <p className="text-xs text-red-600 px-2">{logoutError}</p>}
        </div>
      </aside>

      {/* Main Content Workspace - Offset by sidebar width on desktop */}
      <div className="flex-1 flex flex-col min-w-0 md:pl-64 min-h-screen">
        <header className="hidden md:flex h-16 sticky top-0 z-20 shrink-0 items-center justify-between border-b border-slate-200 bg-white/80 backdrop-blur px-8">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span>Medrella</span>
            <span>/</span>
            <span className="font-medium text-slate-900">{currentRoleMeta.title}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live Clinic Connected
            </span>
            <div className="h-5 w-px bg-slate-200" />
            <NotificationsBell />
          </div>
        </header>

        <main className="flex-1 min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
