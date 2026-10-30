"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Calendar,
  CheckCircle2,
  Clock,
  FileCheck2,
  ListOrdered,
  RefreshCw,
  User,
  XCircle,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import {
  parseDoctorAppointmentsResponseBody,
  type DoctorAppointment,
} from "@/lib/appointment-response";
import { DoctorScheduleManager } from "@/components/doctor-schedule-manager";
import { Button } from "@/components/ui/button";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

function formatTime(startsAt: string, endsAt: string): string {
  const start = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(startsAt));
  const end = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(endsAt));
  return `${start} – ${end} UTC`;
}

function StatusBadge({ status }: { status: DoctorAppointment["status"] }) {
  if (status === "scheduled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700 border border-blue-200">
        <Clock className="h-3 w-3" />
        Scheduled
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 border border-emerald-200">
        <CheckCircle2 className="h-3 w-3" />
        Completed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 border border-slate-200">
      <XCircle className="h-3 w-3" />
      Cancelled
    </span>
  );
}

export function DoctorAppointments() {
  const [appointments, setAppointments] = useState<DoctorAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [currentTime] = useState(() => Date.now());

  // Action states
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmingCancelId, setConfirmingCancelId] = useState<string | null>(null);

  const [completingId, setCompletingId] = useState<string | null>(null);
  const [confirmingCompleteId, setConfirmingCompleteId] = useState<string | null>(null);

  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [activeTab, setActiveTab] = useState<"queue" | "upcoming" | "history" | "schedule">("queue");

  useEffect(() => {
    let active = true;
    async function loadAppointments() {
      try {
        const response = await fetch(`${backendUrl}/api/appointments/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (response.status === 401) {
          throw new Error("Your session expired. Log in again.");
        }
        if (response.status === 403) {
          throw new Error("Your doctor profile is not yet approved by an administrator.");
        }
        if (!response.ok) {
          throw new Error("Could not load your appointments. Please try again.");
        }
        const text = await response.text();
        const parsed = parseDoctorAppointmentsResponseBody(text);
        if (active) {
          setAppointments(parsed);
          setError("");
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Could not load your appointments.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    void loadAppointments();
    return () => {
      active = false;
    };
  }, [refreshTrigger]);

  function handleManualRefresh() {
    setLoading(true);
    setRefreshTrigger((prev) => prev + 1);
  }

  async function handleConfirmCancel(id: string) {
    setCancellingId(id);
    setActionError("");
    setActionNotice("");
    try {
      const response = await fetch(`${backendUrl}/api/appointments/${id}/cancel`, {
        method: "PATCH",
        credentials: "include",
      });
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("You are not authorized to cancel this appointment.");
      if (response.status === 404) throw new Error("Appointment not found or you do not have permission.");
      if (response.status === 409) throw new Error("This appointment is no longer scheduled or was already cancelled.");
      if (!response.ok) throw new Error("Could not cancel the appointment. Please try again.");
      setActionNotice("Appointment was successfully cancelled and slot released.");
      setConfirmingCancelId(null);
      handleManualRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not cancel the appointment.");
    } finally {
      setCancellingId(null);
    }
  }

  async function handleConfirmComplete(id: string) {
    setCompletingId(id);
    setActionError("");
    setActionNotice("");
    try {
      const response = await fetch(`${backendUrl}/api/appointments/${id}/complete`, {
        method: "PATCH",
        credentials: "include",
      });
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("You are not authorized to complete this appointment.");
      if (response.status === 404) throw new Error("Appointment not found or you do not have permission.");
      if (response.status === 409) throw new Error("This appointment cannot be completed (it may already be completed or cancelled).");
      if (!response.ok) throw new Error("Could not complete the appointment. Please try again.");
      setActionNotice("Consultation successfully marked as completed.");
      setConfirmingCompleteId(null);
      handleManualRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not complete the appointment.");
    } finally {
      setCompletingId(null);
    }
  }

  // Today's date string in YYYY-MM-DD UTC
  const todayUtc = useMemo(() => new Date(currentTime).toISOString().slice(0, 10), [currentTime]);

  // Today's Queue: Appointments starting today (UTC)
  const todayQueue = useMemo(() => {
    return appointments
      .filter((a) => a.startsAt.slice(0, 10) === todayUtc)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [appointments, todayUtc]);

  // Upcoming: Future scheduled appointments after today
  const upcomingConsultations = useMemo(() => {
    return appointments
      .filter((a) => a.status === "scheduled" && a.startsAt.slice(0, 10) > todayUtc)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [appointments, todayUtc]);

  // Past / History: Completed or cancelled, or past dates
  const historyConsultations = useMemo(() => {
    return appointments
      .filter((a) => a.status !== "scheduled" || new Date(a.endsAt).getTime() < currentTime)
      .sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());
  }, [appointments, currentTime]);

  const scheduledCount = appointments.filter((a) => a.status === "scheduled").length;
  const completedCount = appointments.filter((a) => a.status === "completed").length;

  return (
    <div className="space-y-6">
      {/* Clinic Workspace Metrics Bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Today&apos;s Queue
            </span>
            <Clock className="h-4 w-4 text-teal-700" />
          </div>
          <p className="mt-2 text-2xl font-extrabold text-slate-900">{todayQueue.length}</p>
          <p className="text-[11px] text-slate-500">Patients on schedule today</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Future Bookings
            </span>
            <Calendar className="h-4 w-4 text-blue-600" />
          </div>
          <p className="mt-2 text-2xl font-extrabold text-slate-900">{upcomingConsultations.length}</p>
          <p className="text-[11px] text-slate-500">Scheduled beyond today</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Completed
            </span>
            <FileCheck2 className="h-4 w-4 text-emerald-600" />
          </div>
          <p className="mt-2 text-2xl font-extrabold text-slate-900">{completedCount}</p>
          <p className="text-[11px] text-slate-500">Concluded consultations</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Total Active
            </span>
            <User className="h-4 w-4 text-slate-700" />
          </div>
          <p className="mt-2 text-2xl font-extrabold text-slate-900">{scheduledCount}</p>
          <p className="text-[11px] text-slate-500">Open appointments</p>
        </div>
      </div>

      {/* Action feedback banners */}
      {actionNotice && (
        <div role="status" className="rounded-xl bg-emerald-50 p-4 text-xs font-medium text-emerald-800 border border-emerald-200">
          {actionNotice}
        </div>
      )}
      {actionError && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-xs font-medium text-red-700 border border-red-200">
          {actionError}
        </div>
      )}

      {/* Main Workspace Tabs */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-200 px-6 py-4 gap-4">
          <div className="flex items-center gap-2">
            <ListOrdered className="h-5 w-5 text-teal-700" />
            <h2 className="text-lg font-bold text-slate-900">Patient Consultation Queue</h2>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setActiveTab("queue")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "queue"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Today ({todayQueue.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("upcoming")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "upcoming"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Upcoming ({upcomingConsultations.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("history")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "history"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                History ({historyConsultations.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("schedule")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "schedule"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Schedule & Availability
              </button>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleManualRefresh}
              disabled={loading}
              className="text-xs h-8"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Updating…" : "Refresh"}
            </Button>
          </div>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {loading && (
            <div className="py-8 text-center text-xs text-slate-500">
              <RefreshCw className="h-5 w-5 text-teal-700 animate-spin mx-auto mb-2" />
              Retrieving live patient queue…
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4">
              <p role="alert" className="text-xs text-red-700 font-medium">{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 text-xs"
                onClick={handleManualRefresh}
              >
                Try again
              </Button>
            </div>
          )}

          {!loading && !error && (
            <>
              {activeTab === "queue" && (
                <div>
                  {todayQueue.length === 0 ? (
                    <div className="py-12 text-center">
                      <Clock className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-slate-800">
                        No appointments scheduled for today
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Any consultations booked for today ({todayUtc} UTC) will automatically appear in this queue.
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {todayQueue.map((appt) => (
                        <DoctorAppointmentCard
                          key={appt.id}
                          appointment={appt}
                          isConfirmingCancel={confirmingCancelId === appt.id}
                          isCancelling={cancellingId === appt.id}
                          isConfirmingComplete={confirmingCompleteId === appt.id}
                          isCompleting={completingId === appt.id}
                          onStartCancel={() => {
                            setConfirmingCancelId(appt.id);
                            setConfirmingCompleteId(null);
                            setActionError("");
                          }}
                          onCancelConfirm={() => void handleConfirmCancel(appt.id)}
                          onCancelDismiss={() => setConfirmingCancelId(null)}
                          onStartComplete={() => {
                            setConfirmingCompleteId(appt.id);
                            setConfirmingCancelId(null);
                            setActionError("");
                          }}
                          onCompleteConfirm={() => void handleConfirmComplete(appt.id)}
                          onCompleteDismiss={() => setConfirmingCompleteId(null)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === "upcoming" && (
                <div>
                  {upcomingConsultations.length === 0 ? (
                    <div className="py-12 text-center">
                      <Calendar className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-slate-800">
                        No future bookings scheduled
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Future bookings from patients will appear here sorted chronologically.
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {upcomingConsultations.map((appt) => (
                        <DoctorAppointmentCard
                          key={appt.id}
                          appointment={appt}
                          isConfirmingCancel={confirmingCancelId === appt.id}
                          isCancelling={cancellingId === appt.id}
                          isConfirmingComplete={confirmingCompleteId === appt.id}
                          isCompleting={completingId === appt.id}
                          onStartCancel={() => {
                            setConfirmingCancelId(appt.id);
                            setConfirmingCompleteId(null);
                            setActionError("");
                          }}
                          onCancelConfirm={() => void handleConfirmCancel(appt.id)}
                          onCancelDismiss={() => setConfirmingCancelId(null)}
                          onStartComplete={() => {
                            setConfirmingCompleteId(appt.id);
                            setConfirmingCancelId(null);
                            setActionError("");
                          }}
                          onCompleteConfirm={() => void handleConfirmComplete(appt.id)}
                          onCompleteDismiss={() => setConfirmingCompleteId(null)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === "history" && (
                <div>
                  {historyConsultations.length === 0 ? (
                    <div className="py-12 text-center">
                      <FileCheck2 className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-slate-800">
                        No consultation history yet
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Completed and past cancelled consultations will be recorded here.
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {historyConsultations.map((appt) => (
                        <DoctorAppointmentCard
                          key={appt.id}
                          appointment={appt}
                          isPast
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === "schedule" && (
                <DoctorScheduleManager />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DoctorAppointmentCard({
  appointment,
  isPast = false,
  isConfirmingCancel = false,
  isCancelling = false,
  isConfirmingComplete = false,
  isCompleting = false,
  onStartCancel,
  onCancelConfirm,
  onCancelDismiss,
  onStartComplete,
  onCompleteConfirm,
  onCompleteDismiss,
}: {
  appointment: DoctorAppointment;
  isPast?: boolean;
  isConfirmingCancel?: boolean;
  isCancelling?: boolean;
  isConfirmingComplete?: boolean;
  isCompleting?: boolean;
  onStartCancel?: () => void;
  onCancelConfirm?: () => void;
  onCancelDismiss?: () => void;
  onStartComplete?: () => void;
  onCompleteConfirm?: () => void;
  onCompleteDismiss?: () => void;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 transition ${
        isPast
          ? "border-slate-200 bg-slate-50/60"
          : "border-slate-200 bg-white hover:border-teal-400 shadow-xs"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-800 font-bold border border-teal-200">
            {appointment.patient.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-teal-700">
              Patient
            </span>
            <p className="text-sm font-bold text-slate-900">{appointment.patient.name}</p>
          </div>
        </div>
        <StatusBadge status={appointment.status} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-xs">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Consultation Date
          </dt>
          <dd className="mt-0.5 font-semibold text-slate-800">
            {formatDate(appointment.startsAt)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Time Window
          </dt>
          <dd className="mt-0.5 font-semibold text-slate-800">
            {formatTime(appointment.startsAt, appointment.endsAt)}
          </dd>
        </div>
      </dl>

      {!isPast && appointment.status === "scheduled" && (
        <div className="mt-4 border-t border-slate-100 pt-3 space-y-2">
          {/* Complete confirmation dialog */}
          {isConfirmingComplete && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2">
              <p className="text-xs font-bold text-emerald-900">
                Mark consultation as completed?
              </p>
              <p className="text-[11px] text-emerald-800">
                This indicates the consultation session with {appointment.patient.name} has concluded.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs bg-emerald-700 text-white hover:bg-emerald-800"
                  disabled={isCompleting}
                  onClick={onCompleteConfirm}
                >
                  {isCompleting ? "Completing…" : "Confirm complete"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-emerald-300"
                  disabled={isCompleting}
                  onClick={onCompleteDismiss}
                >
                  Back
                </Button>
              </div>
            </div>
          )}

          {/* Cancel confirmation dialog */}
          {isConfirmingCancel && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 space-y-2">
              <p className="text-xs font-bold text-red-900">
                Cancel this patient consultation?
              </p>
              <p className="text-[11px] text-red-800">
                This will release the reserved time slot for other bookings.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs bg-red-600 text-white hover:bg-red-700"
                  disabled={isCancelling}
                  onClick={onCancelConfirm}
                >
                  {isCancelling ? "Cancelling…" : "Confirm cancel"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-slate-300"
                  disabled={isCancelling}
                  onClick={onCancelDismiss}
                >
                  Keep
                </Button>
              </div>
            </div>
          )}

          {/* Normal Action Buttons */}
          {!isConfirmingCancel && !isConfirmingComplete && (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 font-semibold"
                onClick={onStartComplete}
              >
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                Complete Consultation
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={onStartCancel}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
