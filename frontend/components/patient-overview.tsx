"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bell,
  Calendar,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  Clock,
  HeartPulse,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  User,
  XCircle,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import {
  parsePatientAppointmentsResponseBody,
  type PatientAppointment,
} from "@/lib/appointment-response";
import type { InAppNotification } from "@/components/notifications-bell";
import { PatientAppointments } from "@/components/patient-appointments";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PatientOverviewProps {
  name: string;
}

export function PatientOverview({ name }: PatientOverviewProps) {
  const [appointments, setAppointments] = useState<PatientAppointment[]>([]);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [doctorCount, setDoctorCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadDashboardData() {
      setLoading(true);
      setError("");
      try {
        const [apptsRes, notifsRes, docsRes] = await Promise.all([
          fetch(`${backendUrl}/api/appointments/me`, {
            credentials: "include",
            cache: "no-store",
          }),
          fetch(`${backendUrl}/api/notifications`, {
            credentials: "include",
            cache: "no-store",
          }).catch(() => null),
          fetch(`${backendUrl}/api/doctors`, {
            credentials: "include",
            cache: "no-store",
          }).catch(() => null),
        ]);

        if (!apptsRes.ok) {
          if (apptsRes.status === 401) {
            throw new Error("Your session expired. Please log in again.");
          }
          throw new Error("Could not load your appointments. Please try again.");
        }

        const apptsText = await apptsRes.text();
        const parsedAppts = parsePatientAppointmentsResponseBody(apptsText);
        if (active) setAppointments(parsedAppts);

        if (notifsRes && notifsRes.ok) {
          try {
            const notifsList: InAppNotification[] = await notifsRes.json();
            if (active && Array.isArray(notifsList)) {
              setNotifications(notifsList.slice(0, 5));
            }
          } catch {
            // Ignore notification parse error
          }
        }

        if (docsRes && docsRes.ok) {
          try {
            const docsList = await docsRes.json();
            if (active && Array.isArray(docsList)) {
              setDoctorCount(docsList.length);
            }
          } catch {
            // Ignore doctors parse error
          }
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Failed to load dashboard data.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadDashboardData();
    return () => {
      active = false;
    };
  }, [refreshKey]);

  // Derived metrics
  const [currentTime] = useState(() => Date.now());

  const upcomingAppointments = useMemo(() => {
    return appointments
      .filter((a) => a.status === "scheduled" && new Date(a.endsAt).getTime() > currentTime)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [appointments, currentTime]);

  const completedCount = useMemo(() => {
    return appointments.filter((a) => a.status === "completed").length;
  }, [appointments]);

  const cancelledCount = useMemo(() => {
    return appointments.filter((a) => a.status === "cancelled").length;
  }, [appointments]);

  const nextAppointment = upcomingAppointments[0] ?? null;

  function formatDateTime(startsAt: string, endsAt: string): string {
    const dateStr = new Intl.DateTimeFormat("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    }).format(new Date(startsAt));

    const startTime = new Intl.DateTimeFormat("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
    }).format(new Date(startsAt));

    const endTime = new Intl.DateTimeFormat("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
    }).format(new Date(endsAt));

    return `${dateStr} • ${startTime} – ${endTime} IST`;
  }

  function formatRelativeTime(iso: string): string {
    try {
      const diffMs = currentTime - new Date(iso).getTime();
      const diffMinutes = Math.floor(diffMs / 60000);
      if (diffMinutes < 1) return "Just now";
      if (diffMinutes < 60) return `${diffMinutes}m ago`;
      const diffHours = Math.floor(diffMinutes / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays}d ago`;
    } catch {
      return "";
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 space-y-8">
      {/* Hero Welcome Banner */}
      <div className="relative overflow-hidden rounded-3xl border border-teal-100 bg-gradient-to-br from-teal-900 via-teal-800 to-slate-900 p-6 sm:p-8 text-white shadow-lg">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full bg-teal-700/60 px-3 py-1 text-xs font-semibold text-teal-200 backdrop-blur border border-teal-500/30">
              <Sparkles className="h-3.5 w-3.5 text-teal-300" />
              Patient Care Workspace
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Welcome back, {name}
            </h1>
            <p className="text-teal-100/90 text-sm max-w-xl leading-relaxed">
              Monitor your upcoming consultations, view clinical records, and connect with verified medical specialists across all disciplines.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Link
                href="/patient/book-appointment"
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-4 py-2.5 text-xs shadow-md transition transform active:scale-95"
              >
                <Plus className="h-4 w-4 stroke-[2.5]" />
                Book an Appointment
              </Link>
              <Link
                href="/patient/profile"
                className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 hover:bg-white/25 px-3.5 py-2.5 text-xs font-semibold text-white transition border border-white/20 backdrop-blur shadow-xs"
              >
                <User className="h-3.5 w-3.5 text-teal-200" />
                Manage Profile
              </Link>
            </div>
          </div>

          {/* Quick Metrics Badge */}
          <div className="flex items-center gap-4 bg-white/10 backdrop-blur rounded-2xl p-4 border border-white/15 shrink-0 self-start md:self-auto">
            <div className="text-center px-3">
              <p className="text-2xl sm:text-3xl font-extrabold text-white">
                {upcomingAppointments.length}
              </p>
              <p className="text-[11px] font-medium text-teal-200 uppercase tracking-wider">
                Upcoming
              </p>
            </div>
            <div className="h-10 w-px bg-white/20" />
            <div className="text-center px-3">
              <p className="text-2xl sm:text-3xl font-extrabold text-white">
                {completedCount}
              </p>
              <p className="text-[11px] font-medium text-teal-200 uppercase tracking-wider">
                Completed
              </p>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-semibold">Unable to load complete dashboard information</p>
          <p className="text-xs text-red-600 mt-1">{error}</p>
        </div>
      )}

      {/* Summary KPI Cards */}
      <section aria-labelledby="summary-kpis" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-slate-200 bg-white shadow-xs">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-teal-50 text-teal-700 border border-teal-100">
              <Clock className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Upcoming
              </p>
              <p className="text-2xl font-bold text-slate-900 mt-0.5">
                {loading ? "…" : upcomingAppointments.length}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white shadow-xs">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700 border border-emerald-100">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Completed
              </p>
              <p className="text-2xl font-bold text-slate-900 mt-0.5">
                {loading ? "…" : completedCount}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white shadow-xs">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-600 border border-slate-200">
              <XCircle className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Cancelled
              </p>
              <p className="text-2xl font-bold text-slate-900 mt-0.5">
                {loading ? "…" : cancelledCount}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white shadow-xs">
          <CardContent className="p-5 flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-700 border border-cyan-100">
              <Stethoscope className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Specialists
              </p>
              <p className="text-2xl font-bold text-slate-900 mt-0.5">
                {doctorCount !== null ? doctorCount : "10+"}
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Spotlight: Next Upcoming Appointment & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Next Appointment Spotlight (7 Cols) */}
        <section aria-labelledby="next-appointment-heading" className="lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between">
            <h2 id="next-appointment-heading" className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <CalendarCheck className="h-5 w-5 text-teal-700" />
              Next Scheduled Appointment
            </h2>
            <Link
              href="/patient/book-appointment"
              className="text-xs font-semibold text-teal-700 hover:text-teal-800 flex items-center gap-1"
            >
              Book another
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {loading && (
            <Card className="border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              <HeartPulse className="h-6 w-6 text-teal-600 animate-pulse mx-auto mb-2" />
              Checking your scheduled appointments…
            </Card>
          )}

          {!loading && nextAppointment && (
            <Card className="border-teal-200 bg-gradient-to-br from-teal-50/60 via-white to-cyan-50/40 shadow-sm relative overflow-hidden">
              <div className="absolute top-0 right-0 h-28 w-28 bg-teal-100/50 rounded-bl-full pointer-events-none" />
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-bold text-teal-800 mb-2">
                      <Clock className="h-3 w-3" />
                      Confirmed Appointment
                    </span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-xl font-bold text-slate-900">
                        Dr. {nextAppointment.doctor.name}
                      </CardTitle>
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 border border-emerald-200">
                        <ShieldCheck className="h-3 w-3 text-emerald-600" />
                        Verified Doctor
                      </span>
                    </div>
                    <CardDescription className="text-xs font-semibold text-teal-700">
                      {nextAppointment.doctor.specialty}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-4 pt-1">
                <div className="rounded-xl border border-teal-100 bg-white/80 p-3.5 text-xs text-slate-700 space-y-1.5">
                  <p className="flex items-center gap-2 font-semibold text-slate-900">
                    <Calendar className="h-4 w-4 text-teal-700 shrink-0" />
                    {formatDateTime(nextAppointment.startsAt, nextAppointment.endsAt)}
                  </p>
                  {nextAppointment.doctor.bio && (
                    <p className="text-slate-500 line-clamp-2 pt-1 border-t border-slate-100">
                      {nextAppointment.doctor.bio}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <Link
                    href="/patient/book-appointment"
                    className="inline-flex items-center gap-1.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs px-3.5 py-2 transition shadow-xs"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Book Additional Slot
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.getElementById("appointment-history-section");
                      el?.scrollIntoView({ behavior: "smooth" });
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs px-3.5 py-2 transition"
                  >
                    Manage / Reschedule Below
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </CardContent>
            </Card>
          )}

          {!loading && !nextAppointment && (
            <Card className="border-slate-200 bg-white p-6 sm:p-8 text-center space-y-3">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-50 text-teal-700">
                <CalendarDays className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900 text-base">No upcoming consultations</h3>
                <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
                  You do not have any appointments scheduled currently. Pick an approved physician to book your next consultation slot.
                </p>
              </div>
              <div className="pt-2">
                <Link
                  href="/patient/book-appointment"
                  className="inline-flex items-center gap-2 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs px-4 py-2.5 transition shadow-xs"
                >
                  <Plus className="h-4 w-4" />
                  Browse Specialists & Book
                </Link>
              </div>
            </Card>
          )}
        </section>

        {/* Recent Notifications / Activity Feed (5 Cols) */}
        <section aria-labelledby="activity-heading" className="lg:col-span-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 id="activity-heading" className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Bell className="h-5 w-5 text-teal-700" />
              Recent Activity
            </h2>
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              className="text-slate-400 hover:text-slate-600 transition"
              title="Refresh activity"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>

          <Card className="border-slate-200 bg-white shadow-xs">
            <CardContent className="p-4 space-y-3">
              {notifications.length === 0 && (
                <div className="py-8 text-center text-xs text-slate-500">
                  <Activity className="h-6 w-6 text-slate-300 mx-auto mb-2" />
                  No recent activity recorded.
                </div>
              )}

              {notifications.map((notif) => {
                const isBooking = notif.type === "booking";
                const isCancel = notif.type === "cancellation";
                const isReschedule = notif.type === "reschedule";

                return (
                  <div
                    key={notif.id}
                    className="flex items-start gap-3 p-2.5 rounded-xl bg-slate-50 hover:bg-teal-50/50 transition border border-slate-100"
                  >
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 ${
                        isBooking
                          ? "bg-teal-100 text-teal-800"
                          : isCancel
                          ? "bg-red-100 text-red-800"
                          : isReschedule
                          ? "bg-amber-100 text-amber-800"
                          : "bg-blue-100 text-blue-800"
                      }`}
                    >
                      <Activity className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-900 truncate">
                          {notif.title}
                        </p>
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {formatRelativeTime(notif.createdAt)}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 line-clamp-2 mt-0.5">
                        {notif.message}
                      </p>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </section>
      </div>

      {/* Onboarding Guide for Brand New Patients */}
      {!loading && appointments.length === 0 && (
        <Card className="border-teal-200 bg-gradient-to-r from-teal-50 via-cyan-50 to-white shadow-xs">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-teal-700" />
              <CardTitle className="text-base font-bold text-slate-900">
                New to Medrella? Here is how scheduling works
              </CardTitle>
            </div>
            <CardDescription className="text-xs text-slate-600">
              Three simple steps to connect with licensed healthcare practitioners.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3 pt-0">
            <div className="rounded-xl border border-teal-100 bg-white p-4 space-y-1">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-700 text-white text-xs font-bold mb-2">
                1
              </div>
              <p className="text-xs font-bold text-slate-900">Find a Specialist</p>
              <p className="text-[11px] text-slate-600 leading-normal">
                Search verified physicians by discipline, clinical experience, consultation fee, and clinic location.
              </p>
            </div>

            <div className="rounded-xl border border-teal-100 bg-white p-4 space-y-1">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-700 text-white text-xs font-bold mb-2">
                2
              </div>
              <p className="text-xs font-bold text-slate-900">Select an IST Slot</p>
              <p className="text-[11px] text-slate-600 leading-normal">
                Choose an open consultation window between 09:00 and 17:00 IST tailored to the physician&apos;s real-time schedule.
              </p>
            </div>

            <div className="rounded-xl border border-teal-100 bg-white p-4 space-y-1">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-700 text-white text-xs font-bold mb-2">
                3
              </div>
              <p className="text-xs font-bold text-slate-900">Instant Clinical Confirmation</p>
              <p className="text-[11px] text-slate-600 leading-normal">
                Receive live automated confirmation, in-app notifications, and flexible rescheduling capabilities.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Complete Appointment History & Management Section */}
      <div id="appointment-history-section" className="pt-2">
        <PatientAppointments
          refreshKey={refreshKey}
          onCancelled={() => setRefreshKey((k) => k + 1)}
        />
      </div>
    </div>
  );
}
