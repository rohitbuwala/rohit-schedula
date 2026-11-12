"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Calendar,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Globe2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { parseDoctorAppointmentsResponseBody, type DoctorAppointment } from "@/lib/appointment-response";

interface DoctorScheduleData {
  timezone: string;
  activeDays: number[];
  startHour: number;
  endHour: number;
  slotDurationMinutes: number;
  schedulingMode: "wave" | "stream";
  capacity: number;
  breakStart: string | null;
  breakEnd: string | null;
  leaves: Array<{
    id: string;
    date: string;
    reason?: string;
    createdAt: string;
  }>;
  overrides: Array<{
    id: string;
    date: string;
    startHour: number;
    endHour: number;
    slotDurationMinutes: number;
    schedulingMode: "wave" | "stream" | null;
    capacity: number | null;
    breakStart: string | null;
    breakEnd: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

interface ScheduleRequestSummary {
  id: string;
  status: "pending" | "published" | "cancelled" | "expired";
  expiresAt: string;
  approvedAt: string | null;
  publicationBlocked?: boolean;
  publicationBlockers?: Array<{ id: string; reason: string }>;
  affectedAppointments: Array<{
    id: string;
    consentStatus: "pending" | "accepted" | "declined";
    resolutionStatus: string;
    appointmentId: string;
    originalStartsAt: string;
    originalEndsAt: string;
    conflictReason: string;
    patient: { id: string; name: string };
    appointment: {
      id: string;
      startsAt: string;
      endsAt: string;
      status: "pending_payment" | "scheduled" | "cancelled" | "completed";
    };
    payment: { status: "created" | "captured" | "failed" | "refunded"; statusDisplay: string } | null;
    alternatives: Array<{
      id: string;
      startsAt: string;
      endsAt: string;
      rank: number;
    }>;
  }>;
}

interface ProposalEditor {
  requestId: string;
  affectedAppointmentId: string;
  alternativeIds: string[];
}

const COMMON_TIMEZONES = [
  "UTC",
  "Asia/Kolkata",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const WEEKDAY_NAMES = [
  { day: 0, label: "Sun" },
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
];

export function DoctorScheduleManager() {
  const [schedule, setSchedule] = useState<DoctorScheduleData | null>(null);
  const [upcomingAppointments, setUpcomingAppointments] = useState<DoctorAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [appointmentError, setAppointmentError] = useState("");
  const [scheduleType, setScheduleType] = useState<"recurring" | "single">("recurring");
  const [scheduleRequests, setScheduleRequests] = useState<ScheduleRequestSummary[]>([]);
  const [proposalEditor, setProposalEditor] = useState<ProposalEditor | null>(null);
  const [savingProposal, setSavingProposal] = useState(false);

  // Schedule form state
  const [timezone, setTimezone] = useState("UTC");
  const [activeDays, setActiveDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(17);
  const [slotDurationMinutes, setSlotDurationMinutes] = useState(30);
  const [schedulingMode, setSchedulingMode] = useState<"wave" | "stream">("stream");
  const [capacity, setCapacity] = useState(1);
  const [breakStart, setBreakStart] = useState("");
  const [breakEnd, setBreakEnd] = useState("");

  // Conflict state
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [conflictResult, setConflictResult] = useState<{
    hasConflicts: boolean;
    conflictCount: number;
    conflicts: Array<{ id: string; startsAt: string; reason: string }>;
  } | null>(null);

  // Leave form state
  const [leaveDate, setLeaveDate] = useState("");
  const [leaveReason, setLeaveReason] = useState("");
  const [addingLeave, setAddingLeave] = useState(false);
  const [overrideDate, setOverrideDate] = useState("");
  const [overrideStartHour, setOverrideStartHour] = useState(9);
  const [overrideEndHour, setOverrideEndHour] = useState(17);
  const [overrideDuration, setOverrideDuration] = useState(30);
  const [overrideCapacity, setOverrideCapacity] = useState("inherit");
  const [overrideMode, setOverrideMode] = useState<"wave" | "stream" | "inherit">("inherit");
  const [overrideBreakStart, setOverrideBreakStart] = useState("");
  const [overrideBreakEnd, setOverrideBreakEnd] = useState("");
  const effectiveOverrideMode = overrideMode === "inherit" ? schedulingMode : overrideMode;

  useEffect(() => {
    let active = true;
    async function loadSchedule() {
      try {
        const [res, appointmentsRes, requestsRes] = await Promise.all([
          fetch(`${backendUrl}/api/doctor/schedule`, { credentials: "include", cache: "no-store" }),
          fetch(`${backendUrl}/api/appointments/me`, { credentials: "include", cache: "no-store" }),
          fetch(`${backendUrl}/api/doctor/schedule/requests`, { credentials: "include", cache: "no-store" }),
        ]);
        if (!res.ok) throw new Error("Could not load schedule settings.");
        const data: DoctorScheduleData = await res.json();
        let upcoming: DoctorAppointment[] = [];
        let requests: ScheduleRequestSummary[] = [];
        if (requestsRes.ok) requests = await requestsRes.json();
        let nextAppointmentError = "";
        if (appointmentsRes.ok) {
          const body = await appointmentsRes.text();
          const appointments = parseDoctorAppointmentsResponseBody(body);
          const now = Date.now();
          upcoming = appointments
            .filter((appointment) => appointment.startsAt && new Date(appointment.startsAt).getTime() >= now &&
              (appointment.status === "scheduled" || appointment.status === "pending_payment"))
            .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
            .slice(0, 6);
        } else {
          nextAppointmentError = "Upcoming bookings are unavailable right now.";
        }
        if (active) {
          setUpcomingAppointments(upcoming);
          setScheduleRequests(requests);
          setAppointmentError(nextAppointmentError);
          setSchedule(data);
          setTimezone(data.timezone || "UTC");
          setActiveDays(data.activeDays || [1, 2, 3, 4, 5]);
          setStartHour(data.startHour ?? 9);
          setEndHour(data.endHour ?? 17);
          setSlotDurationMinutes(data.slotDurationMinutes ?? 30);
          setSchedulingMode(data.schedulingMode ?? "stream");
          setCapacity(data.capacity ?? 1);
          setBreakStart(data.breakStart || "");
          setBreakEnd(data.breakEnd || "");
          setOverrideBreakStart("");
          setOverrideBreakEnd("");
          setError("");
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to load schedule.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSchedule();
    return () => {
      active = false;
    };
  }, []);

  function toggleDay(day: number) {
    setActiveDays((prev) => {
      if (prev.includes(day)) {
        if (prev.length === 1) return prev; // Keep at least 1 day
        return prev.filter((d) => d !== day);
      }
      return [...prev, day].sort((a, b) => a - b);
    });
    setConflictResult(null);
  }

  async function handleCheckConflicts() {
    setCheckingConflicts(true);
    setConflictResult(null);
    setError("");
    try {
      const res = await fetch(`${backendUrl}/api/doctor/schedule/conflicts`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone,
          activeDays,
          startHour,
          endHour,
          ...(schedulingMode === "wave" ? { slotDurationMinutes } : {}),
          schedulingMode,
          capacity,
          breakStart: breakStart.trim() || null,
          breakEnd: breakEnd.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("Could not verify schedule conflicts.");
      const result = await res.json();
      setConflictResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check conflicts.");
    } finally {
      setCheckingConflicts(false);
    }
  }

  async function handleSaveSchedule(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${backendUrl}/api/doctor/schedule/requests`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone,
          activeDays,
          startHour,
          endHour,
          ...(schedulingMode === "wave" ? { slotDurationMinutes } : {}),
          schedulingMode,
          capacity,
          breakStart: breakStart.trim() || null,
          breakEnd: breakEnd.trim() || null,
        }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
          ? body.message
          : "Could not create a schedule change request.";
        throw new Error(message);
      }
      const responseBody = body as {
        request: ScheduleRequestSummary;
        affectedAppointments?: ScheduleRequestSummary["affectedAppointments"];
      };
      const created = {
        ...responseBody.request,
        affectedAppointments: responseBody.affectedAppointments ?? [],
      };
      const refreshed = await fetch(`${backendUrl}/api/doctor/schedule/requests`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!refreshed.ok) throw new Error("Schedule change request created, but affected appointments could not be loaded.");
      const requests = await refreshed.json() as ScheduleRequestSummary[];
      const latestRequest = requests.find((request) => request.id === created.id);
      const requestWithAffected = latestRequest ?? created;
      setScheduleRequests([
        requestWithAffected,
        ...requests.filter((request) => request.id !== created.id),
      ]);
      setNotice(created.affectedAppointments.length
        ? "Schedule change request created. Review the affected appointments, then approve it to request patient responses."
        : "Schedule change request created. Approve it to publish the new schedule.");
      setConflictResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule.");
    } finally {
      setSaving(false);
    }

  }

  async function handleApproveRequest(requestId: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${backendUrl}/api/doctor/schedule/requests/${requestId}/approve`, {
        method: "POST",
        credentials: "include",
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
          ? body.message
          : "Could not approve the schedule change request.";
        throw new Error(message);
      }

      const approved = body as ScheduleRequestSummary;
      setScheduleRequests((current) => current.map((request) =>
        request.id === requestId ? { ...request, ...approved } : request));
      setNotice(approved.status === "published"
        ? "The schedule change was approved and published."
        : approved.publicationBlocked
          ? "Publication is blocked because an existing appointment still falls outside the proposed schedule. Keep the appointment, choose another valid resolution, or explicitly cancel it before retrying publication."
          : "The schedule change was approved. It remains pending until patients resolve every affected appointment.");
      if (approved.status === "published") {
        const refreshed = await fetch(`${backendUrl}/api/doctor/schedule`, {
          credentials: "include",
          cache: "no-store",
        });
        if (refreshed.ok) setSchedule(await refreshed.json());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve the schedule change request.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCancelAffectedAppointment(requestId: string, affectedAppointmentId: string) {
    if (!window.confirm("No valid alternative is available. Cancel this appointment and process its existing cancellation/refund flow?")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(
        `${backendUrl}/api/appointments/schedule-requests/${requestId}/appointments/${affectedAppointmentId}/cancel`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "No valid schedule-change alternative was available; doctor explicitly cancelled the appointment." }),
        },
      );
      const body: unknown = await res.json();
      if (!res.ok) {
        const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
          ? body.message
          : "Could not cancel the affected appointment.";
        throw new Error(message);
      }
      const refreshed = await fetch(`${backendUrl}/api/doctor/schedule/requests`, {
        credentials: "include", cache: "no-store",
      });
      if (!refreshed.ok) throw new Error("Appointment was cancelled, but schedule requests could not be refreshed.");
      setScheduleRequests(await refreshed.json());
      setNotice("The appointment was cancelled through the existing cancellation and refund flow. You can now approve the request when every affected appointment has a valid resolution.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the affected appointment.");
    } finally {
      setSaving(false);
    }
  }

  function openProposalEditor(
    requestId: string,
    item: ScheduleRequestSummary["affectedAppointments"][number],
  ) {
    setProposalEditor({
      requestId,
      affectedAppointmentId: item.id,
      alternativeIds: item.alternatives.map((alternative) => alternative.id),
    });
  }

  async function handleSaveProposal() {
    if (!proposalEditor || proposalEditor.alternativeIds.length === 0) return;
    setSavingProposal(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(
        `${backendUrl}/api/doctor/schedule/requests/${proposalEditor.requestId}/appointments/${proposalEditor.affectedAppointmentId}/alternatives`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alternativeIds: proposalEditor.alternativeIds }),
        },
      );
      if (!res.ok) {
        const body: unknown = await res.json();
        const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
          ? body.message
          : "Could not save the rescheduling proposal.";
        throw new Error(message);
      }
      const refreshed = await fetch(`${backendUrl}/api/doctor/schedule/requests`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!refreshed.ok) throw new Error("Proposal saved, but schedule requests could not be refreshed.");
      setScheduleRequests(await refreshed.json());
      setProposalEditor(null);
      setNotice("Rescheduling proposal saved. Approve the schedule request separately to send it to the patient for explicit acceptance.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the rescheduling proposal.");
    } finally {
      setSavingProposal(false);
    }
  }

  async function handleAddLeave(e: FormEvent) {
    e.preventDefault();
    if (!leaveDate) return;
    setAddingLeave(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${backendUrl}/api/doctor/schedule/leave`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: leaveDate,
          reason: leaveReason.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error("Could not mark date as unavailable.");
      const newLeave = await res.json();
      setSchedule((prev) => {
        if (!prev) return prev;
        const filtered = prev.leaves.filter((l) => l.date !== newLeave.date);
        return {
          ...prev,
          leaves: [...filtered, newLeave].sort((a, b) => a.date.localeCompare(b.date)),
        };
      });
      setLeaveDate("");
      setLeaveReason("");
      setNotice(`Date ${newLeave.date} was marked as unavailable.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add leave date.");
    } finally {
      setAddingLeave(false);
    }
  }

  async function handleRemoveLeave(leaveId: string) {
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${backendUrl}/api/doctor/schedule/leave/${encodeURIComponent(leaveId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Could not remove leave.");
      setSchedule((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          leaves: prev.leaves.filter((l) => l.id !== leaveId),
        };
      });
      setNotice("Leave date was removed. Availability has been restored.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove leave.");
    }
  }

  async function handleSaveOverride(e: FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${backendUrl}/api/doctor/schedule/override`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: overrideDate,
          startHour: overrideStartHour,
          endHour: overrideEndHour,
          ...(overrideMode === "wave" || (overrideMode === "inherit" && schedulingMode === "wave") ? { slotDurationMinutes: overrideDuration } : {}),
          schedulingMode: overrideMode === "inherit" ? null : overrideMode,
          capacity: overrideCapacity === "inherit" ? null : Number(overrideCapacity),
          breakStart: overrideBreakStart.trim() || null,
          breakEnd: overrideBreakEnd.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("Could not save date-specific availability.");
      const saved = await res.json();
      setSchedule((current) => current ? {
        ...current,
        overrides: [...current.overrides.filter((entry) => entry.date !== saved.date), saved]
          .sort((a, b) => a.date.localeCompare(b.date)),
      } : current);
      setOverrideDate("");
      setOverrideBreakStart("");
      setOverrideBreakEnd("");
      setNotice(`Availability override saved for ${saved.date}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save availability override.");
    }
  }

  async function handleRemoveOverride(date: string) {
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${backendUrl}/api/doctor/schedule/override/${encodeURIComponent(date)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Could not remove availability override.");
      setSchedule((current) => current ? {
        ...current,
        overrides: current.overrides.filter((entry) => entry.date !== date),
      } : current);
      setNotice(`Availability override removed for ${date}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove availability override.");
    }
  }

  if (loading) {
    return (
      <div className="py-12 text-center text-xs text-slate-500">
        <RefreshCw className="h-5 w-5 text-teal-700 animate-spin mx-auto mb-2" />
        Loading schedule settings…
      </div>
    );
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      {notice && (
        <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-sm font-medium text-emerald-900 shadow-sm">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3.5 text-sm font-medium text-rose-800 shadow-sm">
          {error}
        </div>
      )}
      {scheduleRequests.length > 0 && (
        <Card className="border-blue-200 bg-blue-50/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Schedule change requests</CardTitle>
            <CardDescription>Published availability remains unchanged until every affected appointment is resolved.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scheduleRequests.map((request) => {
              const affectedList = request.affectedAppointments ?? [];
              const pending = affectedList.filter((item) => item.consentStatus === "pending").length;
              const readyToRecheck = request.status === "pending" && request.approvedAt !== null && pending === 0;
              return (
                <div key={request.id} className="rounded-xl border border-blue-100 bg-white p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold capitalize text-slate-900">{request.status} request</span>
                    <span className="rounded-full bg-blue-50 px-2 py-1 font-semibold capitalize text-blue-800">
                      {pending ? `${pending} patient response${pending === 1 ? "" : "s"} pending` : readyToRecheck ? "Ready to recheck publication" : "All patients responded"}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-600">Expires {new Date(request.expiresAt).toLocaleString()}</p>
                  {request.status === "pending" && !request.approvedAt && (
                    <Button
                      type="button"
                      size="sm"
                      className="mt-3"
                      disabled={saving}
                      onClick={() => void handleApproveRequest(request.id)}
                    >
                      Approve request
                    </Button>
                  )}
                  {readyToRecheck && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      disabled={saving}
                      onClick={() => void handleApproveRequest(request.id)}
                    >
                      Recheck publication
                    </Button>
                  )}
                  {request.publicationBlocked && (
                    <p role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900">
                      Publication is blocked: an existing booked appointment remains outside the proposed schedule.
                    </p>
                  )}
                  {affectedList.length > 0 && (
                    <section className="mt-4 border-t border-slate-100 pt-4" aria-label="Affected Appointments">
                      <h4 className="font-semibold text-slate-900">Affected Appointments</h4>
                      <p className="mt-1 text-slate-600">
                        Review the automatically generated alternatives for each affected appointment using Smart Reschedule before approving this request.
                      </p>
                      <div className="mt-2 space-y-3">
                        {affectedList.map((item) => (
                          <article key={item.id} className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="font-semibold text-slate-900">{item.patient.name}</p>
                                <p className="mt-1 text-slate-600">
                                  {new Date(item.originalStartsAt).toLocaleString()}–{new Date(item.originalEndsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                                </p>
                              </div>
                              <span className="rounded-full bg-white px-2 py-1 font-semibold text-slate-700">
                                {item.payment?.statusDisplay ?? "No payment record"}
                              </span>
                            </div>
                            <p className="mt-2 text-slate-700">{item.conflictReason}</p>
                            <p className="mt-1 text-slate-500">
                              Patient response: <span className="capitalize">{item.consentStatus}</span> · Resolution: <span className="capitalize">{item.resolutionStatus}</span>
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={saving || request.approvedAt !== null || item.alternatives.length === 0}
                                onClick={() => openProposalEditor(request.id, item)}
                              >
                                Smart Reschedule
                              </Button>
                              {request.status === "pending" && request.approvedAt === null &&
                                item.consentStatus === "pending" && item.resolutionStatus === "pending" &&
                                item.alternatives.length === 0 && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                                  disabled={saving}
                                  onClick={() => void handleCancelAffectedAppointment(request.id, item.id)}
                                >
                                  Cancel appointment
                                </Button>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  )}
                  {affectedList.length === 0 && (
                    <p className="mt-2 text-slate-600">No affected appointments. This schedule change does not conflict with any existing bookings. Approve the request to publish the new schedule immediately.</p>
                  )}
                  {affectedList.length > 0 && request.approvedAt && (
                    <p className="mt-3 text-slate-600">Patient acceptance is required before any appointment is changed.</p>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {proposalEditor && (() => {
        const request = scheduleRequests.find((item) => item.id === proposalEditor.requestId);
        const item = request?.affectedAppointments.find((affected) => affected.id === proposalEditor.affectedAppointmentId);
        if (!request || !item) return null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="reschedule-proposal-title">
            <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="reschedule-proposal-title" className="text-lg font-semibold text-slate-950">
                    Smart Reschedule proposal
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Review and select recommended alternative times for {item.patient.name}. The appointment will not change until the patient accepts.
                  </p>
                </div>
                <button type="button" className="text-sm font-semibold text-slate-500 hover:text-slate-900" onClick={() => setProposalEditor(null)}>
                  Close
                </button>
              </div>
              <div className="mt-4 space-y-2">
                {item.alternatives.map((alternative) => {
                  const checked = proposalEditor.alternativeIds.includes(alternative.id);
                  return (
                    <label key={alternative.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:border-teal-400">
                      <input
                        type="checkbox"
                        name="reschedule-alternative"
                        checked={checked}
                        onChange={() => setProposalEditor((current) => {
                          if (!current) return current;
                          return {
                            ...current,
                            alternativeIds: checked
                              ? current.alternativeIds.filter((id) => id !== alternative.id)
                              : [...current.alternativeIds, alternative.id],
                          };
                        })}
                      />
                      <span className="text-sm font-medium text-slate-800">
                        {new Date(alternative.startsAt).toLocaleString()}–{new Date(alternative.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setProposalEditor(null)}>Cancel</Button>
                <Button type="button" disabled={savingProposal || proposalEditor.alternativeIds.length === 0} onClick={() => void handleSaveProposal()}>
                  {savingProposal ? "Saving…" : "Save proposal"}
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="grid min-w-0 items-start gap-5 sm:gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.75fr)]">
      <div className="min-w-0 space-y-5 sm:space-y-6">
      <Card className="overflow-hidden border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div><p className="text-sm font-semibold tracking-tight text-slate-900">Availability pattern</p><p className="mt-1 text-sm text-slate-600">Choose a recurring weekly schedule or a non-recurring override for one date.</p></div>
          <div role="group" aria-label="Recurring or non-recurring availability" className="grid grid-cols-2 rounded-xl border border-slate-200/80 bg-slate-100/80 p-1">
            <button type="button" aria-pressed={scheduleType === "recurring"} onClick={() => setScheduleType("recurring")} className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-1 ${scheduleType === "recurring" ? "bg-white text-teal-900 shadow-sm ring-1 ring-slate-200/70" : "text-slate-600 hover:bg-white/60 hover:text-slate-900"}`}>Recurring</button>
            <button type="button" aria-pressed={scheduleType === "single"} onClick={() => setScheduleType("single")} className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-1 ${scheduleType === "single" ? "bg-white text-teal-900 shadow-sm ring-1 ring-slate-200/70" : "text-slate-600 hover:bg-white/60 hover:text-slate-900"}`}>Non-recurring</button>
          </div>
        </CardContent>
      </Card>

      {/* Weekly recurring availability */}
      <Card className={`overflow-hidden border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)] ${scheduleType === "recurring" ? "" : "hidden"}`}>
        <CardHeader className="border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-teal-700" />
            <CardTitle className="text-lg font-semibold tracking-tight text-slate-950">
              Weekly Consultation Hours
            </CardTitle>
          </div>
          <CardDescription className="text-sm leading-6">
            Configure your active working weekdays, daily consultation windows, and pause breaks.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <form onSubmit={handleSaveSchedule} className="space-y-6 p-4 sm:p-6">
            {/* Timezone Selector */}
            <div className="space-y-1.5">
              <label htmlFor="schedule-timezone" className="text-xs font-semibold uppercase tracking-wide text-slate-600 flex items-center gap-1.5">
                <Globe2 className="h-3.5 w-3.5 text-slate-400" /> Practitioner Timezone
              </label>
              <select
                id="schedule-timezone"
                value={timezone}
                onChange={(e) => {
                  setTimezone(e.target.value);
                  setConflictResult(null);
                }}
                className="h-11 w-full max-w-sm rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2"
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>

            {/* Active Weekdays */}
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Available Consultation Days
              </p>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_NAMES.map(({ day, label }) => {
                  const active = activeDays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleDay(day)}
                      className={`min-h-11 min-w-11 rounded-xl border px-3 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2 ${
                        active
                          ? "border-teal-800 bg-teal-800 text-white shadow-sm"
                          : "border-slate-200 bg-white text-slate-700 hover:border-teal-300 hover:bg-teal-50/50"
                      }`}
                    >
                      <span className="inline-flex items-center justify-center gap-1">{active && <Check aria-hidden="true" className="h-3.5 w-3.5" />}{label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs leading-5 text-slate-500">
                Slots will only be calculated and made available to patients on selected days.
              </p>
            </div>

            <div className={`max-w-xs space-y-1.5 ${schedulingMode === "stream" ? "hidden" : ""}`}>
              <label htmlFor="schedule-slot-duration" className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Appointment Duration
              </label>
              <select
                id="schedule-slot-duration"
                value={slotDurationMinutes}
                onChange={(event) => setSlotDurationMinutes(Number(event.target.value))}
                className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2"
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
              </select>
            </div>

            <div className="grid max-w-2xl grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <p className="flex min-h-5 items-center text-sm font-semibold text-slate-800">Scheduling mode</p>
                <div role="group" aria-label="Weekly scheduling mode" className="grid h-11 grid-cols-2 rounded-xl border border-slate-200/80 bg-slate-100/80 p-1">
                  {(["wave", "stream"] as const).map((mode) => <button key={mode} type="button" aria-pressed={schedulingMode === mode} onClick={() => setSchedulingMode(mode)} className={`h-full min-h-0 rounded-lg px-3 text-sm font-semibold capitalize transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-1 ${schedulingMode === mode ? "bg-white text-teal-900 shadow-sm ring-1 ring-slate-200/70" : "text-slate-600 hover:bg-white/60 hover:text-slate-900"}`}>{mode}</button>)}
                </div>
                <p className="min-h-10 text-xs leading-5 text-slate-500">Choose how appointment times are grouped.</p>
              </div>
              <div className="min-w-0 space-y-2">
                <label htmlFor="schedule-capacity" className="flex min-h-5 items-center text-sm font-semibold text-slate-800">Capacity per {schedulingMode === "wave" ? "session" : "slot"}</label>
                <Input id="schedule-capacity" type="number" min={1} max={100} value={capacity} onChange={(event) => setCapacity(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} />
                <p className="min-h-10 text-xs leading-5 text-slate-500">Patients accepted in the same time window.</p>
              </div>
            </div>

            {/* Daily Working Window */}
            <div className="grid grid-cols-2 gap-4 max-w-md">
              <div className="space-y-1.5">
                <label htmlFor="schedule-start-hour" className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Daily Start Hour
                </label>
                <select
                  id="schedule-start-hour"
                  value={startHour}
                  onChange={(e) => {
                    setStartHour(Number(e.target.value));
                    setConflictResult(null);
                  }}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2"
                >
                  {Array.from({ length: 24 }).map((_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="schedule-end-hour" className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Daily End Hour
                </label>
                <select
                  id="schedule-end-hour"
                  value={endHour}
                  onChange={(e) => {
                    setEndHour(Number(e.target.value));
                    setConflictResult(null);
                  }}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2"
                >
                  {Array.from({ length: 24 }).map((_, h) => {
                    const val = h + 1;
                    return (
                      <option key={val} value={val} disabled={val <= startHour}>
                        {String(val).padStart(2, "0")}:00
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            {/* Break / Lunch Window */}
            <div className="space-y-2 border-t border-slate-100 pt-4">
              <label htmlFor="schedule-break-start" className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Break / Lunch Window (Optional)
              </label>
              <div className="grid w-full max-w-lg grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <label htmlFor="schedule-break-start" className="min-w-0 space-y-1 text-xs font-medium text-slate-600">
                  Start time
                  <Input
                    id="schedule-break-start"
                    type="text"
                    placeholder="13:00"
                    value={breakStart}
                    onChange={(e) => {
                      setBreakStart(e.target.value);
                      setConflictResult(null);
                    }}
                    className="text-sm"
                  />
                </label>
                <label htmlFor="schedule-break-end" className="min-w-0 space-y-1 text-xs font-medium text-slate-600">
                  End time
                  <Input
                    id="schedule-break-end"
                    type="text"
                    placeholder="14:00"
                    value={breakEnd}
                    onChange={(e) => {
                      setBreakEnd(e.target.value);
                      setConflictResult(null);
                    }}
                    className="text-sm"
                  />
                </label>
                {(breakStart || breakEnd) && (
                  <button
                    type="button"
                    onClick={() => {
                      setBreakStart("");
                      setBreakEnd("");
                      setConflictResult(null);
                    }}
                    className="min-h-11 justify-self-end rounded-lg px-3 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 hover:text-rose-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2 sm:justify-self-auto"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs leading-5 text-slate-500">
                Slots falling during this interval will not be offered to patients.
              </p>
            </div>

            {/* Conflict Warning Card */}
            {conflictResult && (
              <div
                className={`rounded-xl p-4 text-xs border ${
                  conflictResult.hasConflicts
                    ? "bg-amber-50 border-amber-200 text-amber-900"
                    : "bg-emerald-50 border-emerald-200 text-emerald-800"
                }`}
              >
                {conflictResult.hasConflicts ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 font-bold">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      Warning: {conflictResult.conflictCount} existing appointment(s) or active payment hold(s) conflict with this new schedule!
                    </div>
                    <ul className="list-disc list-inside space-y-1 pl-1 text-[11px]">
                      {conflictResult.conflicts.map((c) => (
                        <li key={c.id}>
                          {new Date(c.startsAt).toUTCString()} — {c.reason}
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] text-amber-700">
                      Please reschedule or cancel affected patient appointments before reducing hours.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 font-semibold">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    No conflicts detected with current patient appointments.
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 md:flex-row md:items-center md:justify-between">
              <Button type="button" variant="outline" onClick={() => document.getElementById("availability-preview")?.focus()} className="min-h-11 w-full md:w-auto">
                Preview schedule
              </Button>
              <div className="flex min-w-0 flex-col gap-2 md:flex-row">
              <Button
                type="submit"
                disabled={saving}
                className="min-h-11 w-full bg-teal-800 px-5 text-white shadow-sm hover:bg-teal-900 disabled:bg-slate-300 disabled:text-slate-600 md:w-auto"
              >
                <Save aria-hidden="true" className="h-4 w-4" />
                {saving ? "Saving schedule…" : "Save weekly schedule"}
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCheckConflicts}
                disabled={checkingConflicts || saving}
                className="min-h-11 w-full md:w-auto"
              >
                <RefreshCw aria-hidden="true" className={`h-4 w-4 ${checkingConflicts ? "animate-spin" : ""}`} />
                {checkingConflicts ? "Verifying…" : "Check Booking Conflicts"}
              </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className={`overflow-hidden border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)] ${scheduleType === "single" ? "" : "hidden"}`}>
        <CardHeader className="border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-teal-700" />
            <CardTitle className="text-lg font-semibold tracking-tight text-slate-950">Date-specific availability</CardTitle>
          </div>
          <CardDescription className="text-sm leading-6">
          Set hours and, for Wave scheduling, appointment duration for one date. This overrides your weekly schedule for that date.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 p-4 sm:p-6">
          <form onSubmit={handleSaveOverride} className="grid min-w-0 grid-cols-1 items-end gap-3 md:grid-cols-6 xl:grid-cols-12">
            <div className="min-w-0 space-y-1 md:col-span-6 xl:col-span-4">
              <label htmlFor="schedule-override-date" className="text-xs font-semibold uppercase tracking-wide text-slate-600">Date</label>
              <Input id="schedule-override-date" type="date" min={new Date().toISOString().slice(0, 10)} value={overrideDate} onChange={(event) => setOverrideDate(event.target.value)} required className="text-sm" />
            </div>
            <div className="min-w-0 space-y-1 md:col-span-3 xl:col-span-2">
              <label htmlFor="schedule-override-start" className="text-xs font-semibold uppercase tracking-wide text-slate-600">Start hour</label>
              <select id="schedule-override-start" value={overrideStartHour} onChange={(event) => setOverrideStartHour(Number(event.target.value))} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm text-slate-800 shadow-sm transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2">
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}
              </select>
            </div>
            <div className="min-w-0 space-y-1 md:col-span-3 xl:col-span-2">
              <label htmlFor="schedule-override-end" className="text-xs font-semibold uppercase tracking-wide text-slate-600">End hour</label>
              <select id="schedule-override-end" value={overrideEndHour} onChange={(event) => setOverrideEndHour(Number(event.target.value))} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm text-slate-800 shadow-sm transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2">
                {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => <option key={hour} value={hour} disabled={hour <= overrideStartHour}>{String(hour).padStart(2, "0")}:00</option>)}
              </select>
            </div>
            <div className={`min-w-0 space-y-1 md:col-span-3 xl:col-span-2 ${effectiveOverrideMode === "stream" ? "hidden" : ""}`}>
              <label htmlFor="schedule-override-duration" className="text-xs font-semibold uppercase tracking-wide text-slate-600">Duration</label>
              <select id="schedule-override-duration" value={overrideDuration} onChange={(event) => setOverrideDuration(Number(event.target.value))} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 shadow-sm transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2">
                <option value={15}>15 minutes</option><option value={30}>30 minutes</option>
              </select>
            </div>
            <div className="grid min-w-0 gap-3 md:col-span-6 md:grid-cols-2 xl:col-span-6">
              <label className="space-y-1 text-xs font-medium text-slate-600">Break starts<Input aria-label="Date override break starts" type="time" value={overrideBreakStart} onChange={(event) => setOverrideBreakStart(event.target.value)} /></label>
              <label className="space-y-1 text-xs font-medium text-slate-600">Break ends<Input aria-label="Date override break ends" type="time" value={overrideBreakEnd} onChange={(event) => setOverrideBreakEnd(event.target.value)} /></label>
            </div>
            <div className="grid min-w-0 grid-cols-1 items-start gap-x-5 gap-y-4 md:col-span-6 md:grid-cols-2 xl:col-span-12">
              <div className="min-w-0 space-y-2">
                <p className="flex min-h-5 items-center text-xs font-semibold uppercase tracking-wide text-slate-600">Mode</p>
                <div role="group" aria-label="One-date scheduling mode" className="grid h-11 grid-cols-3 rounded-xl border border-slate-200/80 bg-slate-100/80 p-1">
                  {(["inherit", "wave", "stream"] as const).map((mode) => <button key={mode} type="button" aria-pressed={overrideMode === mode} onClick={() => setOverrideMode(mode)} className={`h-full min-h-0 rounded-lg px-2 text-xs font-semibold capitalize transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-1 ${overrideMode === mode ? "bg-white text-teal-900 shadow-sm ring-1 ring-slate-200/70" : "text-slate-600 hover:bg-white/60 hover:text-slate-900"}`}>{mode === "inherit" ? "Use weekly" : mode}</button>)}
                </div>
                <p className="min-h-10 text-xs leading-5 text-slate-500">Weekly default: <span className="font-medium capitalize text-slate-700">{schedulingMode}</span>.</p>
              </div>
              <div className="min-w-0 space-y-2">
                <label htmlFor="schedule-override-capacity" className="flex min-h-5 items-center text-xs font-semibold uppercase tracking-wide text-slate-600">Capacity</label>
                <select id="schedule-override-capacity" value={overrideCapacity} onChange={(event) => setOverrideCapacity(event.target.value)} className="h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 shadow-sm transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2">
                  <option value="inherit">Use weekly · {capacity}</option>
                  {Array.from({ length: 20 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <p className="min-h-10 text-xs leading-5 text-slate-500">Patients accepted in the selected time window.</p>
              </div>
              <Button type="submit" disabled={!overrideDate || overrideEndHour <= overrideStartHour} className="min-h-11 w-full bg-teal-800 text-sm text-white shadow-sm hover:bg-teal-900 disabled:bg-slate-300 disabled:text-slate-600 md:col-span-2 md:w-auto md:justify-self-end">
                <Save aria-hidden="true" className="h-4 w-4" /> Save date override
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Doctor Leave & Blackout Dates */}
      <Card className="overflow-hidden border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
        <CardHeader className="border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-teal-700" />
            <CardTitle className="text-lg font-semibold tracking-tight text-slate-950">
              Leave & Unavailable Dates
            </CardTitle>
          </div>
          <CardDescription className="text-sm leading-6">
            Mark holidays, conferences, or leave days when you will not be available for patient bookings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 p-4 sm:p-6">
          <form onSubmit={handleAddLeave} className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
            <div className="w-full min-w-0 sm:w-48 space-y-1">
              <label htmlFor="schedule-leave-date" className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Unavailable Date
              </label>
              <Input
                id="schedule-leave-date"
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                value={leaveDate}
                onChange={(e) => setLeaveDate(e.target.value)}
                required
                className="text-sm"
              />
            </div>
            <div className="w-full min-w-0 sm:flex-1 space-y-1">
              <label htmlFor="schedule-leave-reason" className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Reason (Optional)
              </label>
              <Input
                id="schedule-leave-reason"
                type="text"
                placeholder="e.g. Annual Leave, Medical Conference, Holiday"
                value={leaveReason}
                onChange={(e) => setLeaveReason(e.target.value)}
                className="text-sm"
              />
            </div>
            <Button
              type="submit"
              disabled={addingLeave || !leaveDate}
              className="min-h-11 w-full bg-teal-800 text-sm text-white shadow-sm hover:bg-teal-900 disabled:bg-slate-300 disabled:text-slate-600 sm:w-auto"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {addingLeave ? "Adding…" : "Mark Unavailable"}
            </Button>
          </form>

          {/* Leave list */}
          <div className="pt-2">
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Scheduled Leave Dates ({schedule?.leaves.length ?? 0})
            </h4>

            {schedule?.leaves.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5 text-center">
                <p className="text-sm font-medium text-slate-700">No leave dates currently scheduled. You are available according to your regular weekly schedule.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-200/80 bg-white">
                {schedule?.leaves.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 p-3.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="rounded-lg bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-900 tabular-nums">
                        {l.date}
                      </span>
                      <span className="break-words text-sm font-medium text-slate-700">
                        {l.reason || "Scheduled Leave"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveLeave(l.id)}
                      aria-label={`Remove leave on ${l.date}`}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2"
                      title="Remove leave date"
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      </div>
      <aside className="min-w-0 space-y-5 sm:space-y-6 xl:sticky xl:top-6">
        <Card id="availability-preview" tabIndex={-1} className="overflow-hidden border-teal-200/80 bg-white shadow-[0_2px_8px_rgba(15,23,42,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-700">
          <CardHeader className="border-b border-teal-100 bg-gradient-to-br from-teal-50/90 to-white px-5 py-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-800">Schedule preview</p>
            <CardTitle className="mt-1 text-xl font-semibold tracking-tight text-slate-950">{scheduleType === "recurring" ? "Weekly schedule" : "One-date schedule"}</CardTitle>
            <CardDescription className="text-sm leading-5">A summary of the settings currently in the form.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-semibold capitalize text-teal-900"><span className="h-1.5 w-1.5 rounded-full bg-teal-700" aria-hidden="true" />{scheduleType === "recurring" ? schedulingMode : overrideMode === "inherit" ? schedulingMode : overrideMode}</span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">Capacity <span className="ml-1 tabular-nums text-slate-950">{scheduleType === "recurring" ? capacity : overrideCapacity === "inherit" ? capacity : overrideCapacity}</span></span>
            </div>
            {scheduleType === "recurring" ? (
              <>
                <div className="rounded-xl border border-slate-200/80 bg-white p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Working days</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {activeDays.length === 7 ? (
                      <span className="rounded-lg bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-900">Every day</span>
                    ) : WEEKDAY_NAMES.filter(({ day }) => activeDays.includes(day)).map(({ day, label }) => (
                      <span key={day} className="rounded-lg bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-900">{label}</span>
                    ))}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{String(startHour).padStart(2, "0")}:00–{String(endHour).padStart(2, "0")}:00 <span className="text-slate-400">·</span> {timezone}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-slate-50 p-3.5"><p className="text-xs leading-4 text-slate-500">Appointment length</p><p className="mt-1.5 text-sm font-semibold tabular-nums text-slate-900">{slotDurationMinutes} minutes</p></div>
                  <div className="rounded-xl bg-slate-50 p-3.5"><p className="text-xs leading-4 text-slate-500">Break</p><p className="mt-1.5 text-sm font-semibold tabular-nums text-slate-900">{breakStart && breakEnd ? `${breakStart}–${breakEnd}` : "None"}</p></div>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-slate-200/80 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected date</p>
                <p className="mt-2 text-sm font-semibold leading-6 text-slate-900">{overrideDate ? new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: timezone }).format(new Date(`${overrideDate}T12:00:00`)) : "Choose a date"}</p>
                <p className="mt-1 text-xs leading-5 text-slate-600">{String(overrideStartHour).padStart(2, "0")}:00–{String(overrideEndHour).padStart(2, "0")}:00 <span className="text-slate-400">·</span> {effectiveOverrideMode === "stream" ? "15-minute Stream slots" : `${overrideDuration} minutes`}</p>
              </div>
            )}
            <p className="text-xs leading-5 text-slate-600">This is a settings preview. Patient availability reflects saved settings and live bookings.</p>
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
          <CardHeader className="flex flex-row items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-5">
            <div><CardTitle className="text-lg font-semibold tracking-tight text-slate-950">Upcoming booked times</CardTitle><CardDescription className="mt-1 text-sm">Live appointments on your schedule.</CardDescription></div>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><CalendarDays aria-hidden="true" className="h-5 w-5" /></span>
          </CardHeader>
          <CardContent className="p-4 sm:p-5">
            {appointmentError ? (
              <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900">{appointmentError}</p>
            ) : upcomingAppointments.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-6 text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-white text-slate-500 shadow-sm"><CalendarDays aria-hidden="true" className="h-5 w-5" /></span>
                <p className="mt-3 text-sm font-semibold text-slate-800">No upcoming bookings yet</p>
                <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-slate-500">New reservations will appear here when patients book a time.</p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {upcomingAppointments.map((appointment) => {
                  const zone = schedule?.timezone ?? timezone;
                  const date = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(new Date(appointment.startsAt));
                  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(appointment.startsAt));
                  const end = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(appointment.endsAt));
                  const pending = appointment.status === "pending_payment";
                  return (
                    <li key={appointment.id} className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200/80 p-3.5 transition-colors hover:border-slate-300">
                      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${pending ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-800"}`}><Clock aria-hidden="true" className="h-4 w-4" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-slate-900">{date}</p><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${pending ? "bg-amber-50 text-amber-800" : "bg-teal-50 text-teal-800"}`}>{pending ? "Payment pending" : "Booked"}</span></div>
                        <p className="mt-1 break-words text-xs leading-5 text-slate-600">{time}–{end} · {appointment.patient.name}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
          <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-5">
            <div><CardTitle className="text-lg font-semibold tracking-tight text-slate-950">Date overrides</CardTitle><CardDescription className="mt-1 text-sm">One-day changes to weekly availability.</CardDescription></div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-slate-700">{schedule?.overrides.length ?? 0}</span>
          </CardHeader>
          <CardContent className="p-4 sm:p-5">
            {schedule?.overrides.length ? (
              <ul className="divide-y divide-slate-100">
                {schedule.overrides.map((entry) => (
                  <li key={entry.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: timezone }).format(new Date(`${entry.date}T12:00:00`))}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">{String(entry.startHour).padStart(2, "0")}:00–{String(entry.endHour).padStart(2, "0")}:00 · {entry.slotDurationMinutes} min</p>
                      <p className="mt-1 text-xs font-medium capitalize text-teal-800">{entry.schedulingMode ?? schedulingMode} · capacity {entry.capacity ?? capacity}</p>
                    </div>
                    <button type="button" onClick={() => void handleRemoveOverride(entry.date)} aria-label={`Remove override for ${entry.date}`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2"><Trash2 aria-hidden="true" className="h-4 w-4" /></button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5 text-center">
                <p className="text-sm font-semibold text-slate-800">No date overrides</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">Choose One date to add an exception to your weekly schedule.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </aside>
      </div>
    </div>
  );
}
