"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Calendar,
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

interface DoctorScheduleData {
  timezone: string;
  activeDays: number[];
  startHour: number;
  endHour: number;
  slotDurationMinutes: number;
  breakStart: string | null;
  breakEnd: string | null;
  leaves: Array<{
    id: string;
    date: string;
    reason?: string;
    createdAt: string;
  }>;
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Schedule form state
  const [timezone, setTimezone] = useState("UTC");
  const [activeDays, setActiveDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(17);
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

  useEffect(() => {
    let active = true;
    async function loadSchedule() {
      try {
        const res = await fetch(`${backendUrl}/api/doctor/schedule`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Could not load schedule settings.");
        const data: DoctorScheduleData = await res.json();
        if (active) {
          setSchedule(data);
          setTimezone(data.timezone || "UTC");
          setActiveDays(data.activeDays || [1, 2, 3, 4, 5]);
          setStartHour(data.startHour ?? 9);
          setEndHour(data.endHour ?? 17);
          setBreakStart(data.breakStart || "");
          setBreakEnd(data.breakEnd || "");
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
          slotDurationMinutes: 30,
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
      const res = await fetch(`${backendUrl}/api/doctor/schedule`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone,
          activeDays,
          startHour,
          endHour,
          slotDurationMinutes: 30,
          breakStart: breakStart.trim() || null,
          breakEnd: breakEnd.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("Could not update schedule settings.");
      const updated: DoctorScheduleData = await res.json();
      setSchedule(updated);
      setNotice("Your practice schedule and availability were saved successfully.");
      setConflictResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule.");
    } finally {
      setSaving(false);
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

  if (loading) {
    return (
      <div className="py-12 text-center text-xs text-slate-500">
        <RefreshCw className="h-5 w-5 text-teal-700 animate-spin mx-auto mb-2" />
        Loading schedule settings…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {notice && (
        <div role="status" className="rounded-xl bg-emerald-50 p-4 text-xs font-medium text-emerald-800 border border-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-xs font-medium text-red-700 border border-red-200">
          {error}
        </div>
      )}

      {/* Working Hours & Availability Form */}
      <Card className="border-slate-200 shadow-xs">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-teal-700" />
            <CardTitle className="text-base font-bold text-slate-900">
              Weekly Consultation Hours
            </CardTitle>
          </div>
          <CardDescription className="text-xs">
            Configure your active working weekdays, daily consultation windows, and pause breaks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveSchedule} className="space-y-6">
            {/* Timezone Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <Globe2 className="h-3.5 w-3.5 text-slate-400" /> Practitioner Timezone
              </label>
              <select
                value={timezone}
                onChange={(e) => {
                  setTimezone(e.target.value);
                  setConflictResult(null);
                }}
                className="w-full max-w-sm rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
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
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Available Consultation Days
              </label>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_NAMES.map(({ day, label }) => {
                  const active = activeDays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleDay(day)}
                      className={`h-9 w-12 rounded-xl text-xs font-bold transition ${
                        active
                          ? "bg-teal-700 text-white shadow-xs"
                          : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-400">
                Slots will only be calculated and made available to patients on selected days.
              </p>
            </div>

            {/* Daily Working Window */}
            <div className="grid grid-cols-2 gap-4 max-w-md">
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Daily Start Hour
                </label>
                <select
                  value={startHour}
                  onChange={(e) => {
                    setStartHour(Number(e.target.value));
                    setConflictResult(null);
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  {Array.from({ length: 24 }).map((_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Daily End Hour
                </label>
                <select
                  value={endHour}
                  onChange={(e) => {
                    setEndHour(Number(e.target.value));
                    setConflictResult(null);
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
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
            <div className="space-y-1.5 pt-2 border-t border-slate-100">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Break / Lunch Window (Optional)
              </label>
              <div className="flex items-center gap-3 max-w-sm">
                <Input
                  type="text"
                  placeholder="13:00"
                  value={breakStart}
                  onChange={(e) => {
                    setBreakStart(e.target.value);
                    setConflictResult(null);
                  }}
                  className="text-xs"
                />
                <span className="text-xs text-slate-400">to</span>
                <Input
                  type="text"
                  placeholder="14:00"
                  value={breakEnd}
                  onChange={(e) => {
                    setBreakEnd(e.target.value);
                    setConflictResult(null);
                  }}
                  className="text-xs"
                />
                {(breakStart || breakEnd) && (
                  <button
                    type="button"
                    onClick={() => {
                      setBreakStart("");
                      setBreakEnd("");
                      setConflictResult(null);
                    }}
                    className="text-xs text-red-600 hover:underline shrink-0"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
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
                      Warning: {conflictResult.conflictCount} existing scheduled appointment(s) conflict with this new schedule!
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
            <div className="flex items-center gap-3 pt-4 border-t border-slate-100">
              <Button
                type="submit"
                disabled={saving}
                className="bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold"
              >
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {saving ? "Saving schedule…" : "Save Schedule"}
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCheckConflicts}
                disabled={checkingConflicts || saving}
                className="text-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${checkingConflicts ? "animate-spin" : ""}`} />
                {checkingConflicts ? "Verifying…" : "Check Booking Conflicts"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Doctor Leave & Blackout Dates */}
      <Card className="border-slate-200 shadow-xs">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-teal-700" />
            <CardTitle className="text-base font-bold text-slate-900">
              Leave & Unavailable Dates
            </CardTitle>
          </div>
          <CardDescription className="text-xs">
            Mark holidays, conferences, or leave days when you will not be available for patient bookings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form onSubmit={handleAddLeave} className="flex flex-col sm:flex-row items-end gap-3">
            <div className="w-full sm:w-48 space-y-1">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Unavailable Date
              </label>
              <Input
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                value={leaveDate}
                onChange={(e) => setLeaveDate(e.target.value)}
                required
                className="text-xs"
              />
            </div>
            <div className="w-full sm:flex-1 space-y-1">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Reason (Optional)
              </label>
              <Input
                type="text"
                placeholder="e.g. Annual Leave, Medical Conference, Holiday"
                value={leaveReason}
                onChange={(e) => setLeaveReason(e.target.value)}
                className="text-xs"
              />
            </div>
            <Button
              type="submit"
              disabled={addingLeave || !leaveDate}
              className="w-full sm:w-auto bg-slate-800 hover:bg-slate-900 text-white text-xs"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {addingLeave ? "Adding…" : "Mark Unavailable"}
            </Button>
          </form>

          {/* Leave list */}
          <div className="pt-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
              Scheduled Leave Dates ({schedule?.leaves.length ?? 0})
            </h4>

            {schedule?.leaves.length === 0 ? (
              <p className="text-xs text-slate-500 py-3">
                No leave dates currently scheduled. You are available according to your regular weekly schedule.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/50">
                {schedule?.leaves.map((l) => (
                  <div key={l.id} className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      <span className="rounded-lg bg-teal-100 px-2.5 py-1 text-xs font-bold text-teal-800 font-mono">
                        {l.date}
                      </span>
                      <span className="text-xs text-slate-700 font-medium">
                        {l.reason || "Scheduled Leave"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveLeave(l.id)}
                      className="rounded-lg p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                      title="Remove leave date"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
