"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelQueueAppointment, checkInPatient, completeQueueConsultation, markPatientAbsent, QueueApiError, readDailyQueue, readQueueAssignments, startNextPatient } from "@/lib/queue-api";
import { attendanceLabel, localQueueDate, queueTimeRange } from "@/lib/queue-response";
import { useQueueResource } from "./use-appointment-queue";

export function AppointmentQueue({ role = "doctor", onChanged, onTimezoneChange }: {
  role?: "doctor" | "staff"; onChanged?: () => void; onTimezoneChange?: (timezone: string) => void;
}) {
  const loadAssignments = useCallback((signal: AbortSignal) => readQueueAssignments(signal), []);
  const assignments = useQueueResource("queue-assignments", loadAssignments);
  const [selection, setSelection] = useState("");
  const doctorId = assignments.data?.some(doctor => doctor.doctorId === selection) ? selection : assignments.data?.[0]?.doctorId || "";
  const [zone, setZone] = useState("Asia/Kolkata");
  const [clock, setClock] = useState(() => Date.now());
  const today = localQueueDate(new Date(clock), zone);
  const [chosenDate, setChosenDate] = useState("");
  const date = chosenDate || today;
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{ kind: "absent" | "complete" | "cancel"; id: string; name: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const confirmationPanel = useRef<HTMLDivElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const refreshControl = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!confirmation) return;
    confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmationPanel.current?.focus();
    confirmationPanel.current?.scrollIntoView({ block: "nearest" });
  }, [confirmation]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => { window.clearInterval(timer); pending.current?.abort(); };
  }, []);
  const loadQueue = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await readDailyQueue(doctorId, date, cursor, signal);
      if (!signal.aborted) { setZone(data.timezone); onTimezoneChange?.(data.timezone); }
      return data;
    } catch (cause) {
      if (!signal.aborted && cause instanceof QueueApiError && cause.code === "QUEUE_VERSION_CHANGED" && cursor) {
        setCursor(undefined); setNotice("The queue changed. Showing the first page again.");
      }
      throw cause;
    }
  }, [doctorId, date, cursor, onTimezoneChange]);
  const queue = useQueueResource(doctorId ? `${doctorId}:${date}:${cursor ?? "first"}` : "", loadQueue);
  const data = queue.data;
  const disabled = !!busy || queue.loading || !!queue.error || !data;

  async function act(label: string, command: (signal: AbortSignal) => Promise<unknown>) {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(label); setError(""); setNotice("");
    try {
      await command(controller.signal);
      if (controller.signal.aborted) return;
      setConfirmation(null); setNotice(`${label} completed. Refreshing the queue.`);
      requestAnimationFrame(() => refreshControl.current?.querySelector("button")?.focus());
      window.dispatchEvent(new Event("queue-updated")); onChanged?.();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "The action could not be confirmed. Refresh before retrying.");
        if (cause instanceof QueueApiError && cause.status === 409) setConfirmation(null);
        queue.refresh();
      }
    } finally { if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setBusy(""); } }
  }
  function resetView() { setCursor(undefined); setConfirmation(null); setError(""); setNotice(""); }

  return <section aria-label="Patient check-in and queue" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="flex items-center gap-2 font-bold text-slate-900"><Users className="size-5 text-teal-700" aria-hidden="true" />Patient queue</h3>
        <p className="mt-1 text-xs text-slate-500">{date} · {data?.timezone ?? zone} · Refreshes while this tab is visible</p></div>
      <span ref={refreshControl}><Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => { assignments.refresh(); queue.refresh(); }}><RefreshCw className="mr-1.5 size-4" aria-hidden="true" />Refresh queue</Button></span>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      {role === "staff" && <label className="text-xs font-semibold text-slate-700">Doctor
        <select className="mt-1 block max-w-full rounded-lg border border-slate-300 bg-white p-2 text-sm" value={doctorId} disabled={!!busy} onChange={event => { setSelection(event.target.value); resetView(); }}>
          {assignments.data?.map(doctor => <option key={doctor.doctorId} value={doctor.doctorId}>{doctor.name}</option>)}
        </select></label>}
      <label className="text-xs font-semibold text-slate-700">Service date
        <input type="date" value={date} disabled={!!busy} className="mt-1 block rounded-lg border border-slate-300 bg-white p-2 text-sm" onChange={event => { setChosenDate(event.target.value); resetView(); }} /></label>
      <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => { setChosenDate(""); resetView(); }}>Today</Button>
    </div>
    {assignments.loading && <p role="status" className="text-sm text-slate-500">Loading your assigned queue…</p>}
    {assignments.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{assignments.error}</p>}
    {assignments.data?.length === 0 && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No approved doctor queue is assigned to this account.</p>}
    {queue.loading && <p role="status" className="text-sm text-slate-500">Loading queue…</p>}
    {(queue.error || error) && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error || queue.error} {queue.error && data && "Previously loaded information is shown; refresh before taking another action."}</p>}
    {notice && <p role="status" className="rounded-xl bg-teal-50 p-3 text-sm text-teal-900">{notice}</p>}
    {confirmation && <div ref={confirmationPanel} tabIndex={-1} role="alertdialog" aria-label={confirmation.kind === "complete" ? "Confirm consultation completion" : confirmation.kind === "cancel" ? "Confirm appointment cancellation" : "Confirm patient absence"} aria-describedby="queue-confirm-description" className="rounded-xl border border-amber-300 bg-amber-50 p-4 focus-visible:outline-2 focus-visible:outline-teal-700">
      <p id="queue-confirm-description" className="text-sm font-semibold text-amber-950">{confirmation.kind === "complete" ? `Complete the consultation for ${confirmation.name}?` : confirmation.kind === "cancel" ? `Cancel the appointment for ${confirmation.name}? The existing refund policy will apply.` : `Mark ${confirmation.name} as absent? This does not cancel or refund the booking.`}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" disabled={disabled} onClick={() => void act(confirmation.kind === "complete" ? "Consultation completion" : confirmation.kind === "cancel" ? "Appointment cancellation" : "No-show update", signal => confirmation.kind === "complete" ? completeQueueConsultation(confirmation.id, signal) : confirmation.kind === "cancel" ? cancelQueueAppointment(confirmation.id, signal) : markPatientAbsent(confirmation.id, signal))}>
        {busy || (confirmation.kind === "complete" ? "Confirm completion" : confirmation.kind === "cancel" ? "Confirm cancellation" : "Confirm absence")}</Button>
        <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => { setConfirmation(null); requestAnimationFrame(() => { const target = confirmationTrigger.current; if (target?.isConnected) target.focus(); else refreshControl.current?.querySelector("button")?.focus(); }); }}>Keep unchanged</Button></div>
    </div>}
    {data && <>
      <div className="rounded-2xl border border-teal-200 bg-teal-50 p-4 sm:p-5">
        <p className="text-xs font-bold uppercase tracking-wide text-teal-800">Currently attending</p>
        {data.current ? <div className="mt-2 space-y-2"><p className="break-words text-lg font-bold text-slate-950">{data.current.patientName}</p>
          <p className="text-sm text-teal-950">Token <strong>{data.current.tokenNumber}</strong> · {queueTimeRange(data.current.startsAt, data.current.endsAt, data.current.timezone)} · {data.current.serviceDate}</p>
          {role === "doctor" && <div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled || !!confirmation} onClick={() => setConfirmation({ kind: "complete", id: data.current!.appointmentId, name: data.current!.patientName })}><CheckCircle2 className="mr-2 size-4" aria-hidden="true" />Complete consultation</Button>
            <Button type="button" variant="outline" disabled={disabled || !!confirmation} onClick={() => setConfirmation({ kind: "cancel", id: data.current!.appointmentId, name: data.current!.patientName })}>Cancel appointment</Button></div>}
        </div> : <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-600">No consultation is currently active.</p>
          {role === "doctor" && <Button type="button" disabled={disabled || !!confirmation || !!cursor || !data.waitingCount} onClick={() => void act("Consultation start", signal => startNextPatient(doctorId, date, data.version, signal))}>Start next patient</Button>}</div>}
      </div>
      <div><h4 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-900"><Clock className="size-4 text-teal-700" aria-hidden="true" />Checked in · {data.waitingCount} waiting</h4>
        {!data.waiting.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No checked-in patients on this page.</p>}
        <ol className="space-y-2">{data.waiting.map(patient => <li key={patient.appointmentId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="min-w-0"><p className="break-words font-semibold text-slate-900">{patient.patientName}</p><p className="mt-1 text-xs text-slate-500">{queueTimeRange(patient.startsAt, patient.endsAt, data.timezone)}</p></div>
          <div className="flex flex-wrap items-center gap-3 text-sm"><span className="rounded-lg bg-teal-50 px-3 py-1 text-teal-950">Token <strong>{patient.tokenNumber}</strong></span><span className="text-slate-600">Position <strong>{patient.position}</strong></span>
            {role === "doctor" && <Button type="button" size="sm" variant="outline" disabled={disabled || !!confirmation} aria-label={`Cancel appointment for ${patient.patientName}`} onClick={() => setConfirmation({ kind: "cancel", id: patient.appointmentId, name: patient.patientName })}>Cancel</Button>}</div>
        </li>)}</ol>
      </div>
      <div><h4 className="mb-3 text-sm font-bold text-slate-900">Expected arrivals</h4>
        {!data.expected.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No patients awaiting check-in on this page.</p>}
        <ul className="space-y-2">{data.expected.map(patient => <li key={patient.appointmentId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="min-w-0"><p className="break-words font-semibold text-slate-900">{patient.patientName}</p><p className="mt-1 text-xs text-slate-500">{queueTimeRange(patient.startsAt, patient.endsAt, data.timezone)} · Not checked in</p></div>
          <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={disabled || !!confirmation || date !== today} aria-label={`Check in ${patient.patientName}`} onClick={() => void act("Patient check-in", signal => checkInPatient(patient.appointmentId, signal))}>Check in</Button>
            <Button type="button" variant="outline" size="sm" disabled={disabled || !!confirmation || Date.parse(patient.startsAt) > clock} aria-label={`Mark ${patient.patientName} absent`} onClick={() => setConfirmation({ kind: "absent", id: patient.appointmentId, name: patient.patientName })}>Mark absent</Button>
            {role === "doctor" && <Button type="button" variant="outline" size="sm" disabled={disabled || !!confirmation} aria-label={`Cancel appointment for ${patient.patientName}`} onClick={() => setConfirmation({ kind: "cancel", id: patient.appointmentId, name: patient.patientName })}>Cancel</Button>}</div>
        </li>)}</ul>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        {data.closed.length > 0 && <div className="w-full"><h4 className="mb-2 text-sm font-bold text-slate-900">Completed and closed visits</h4>
          <ul className="space-y-2">{data.closed.map(patient => <li key={patient.appointmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
            <span className="break-words font-medium">{patient.patientName}{patient.tokenNumber !== null ? ` · Token ${patient.tokenNumber}` : ""}</span>
            <span className="text-slate-600">{attendanceLabel(patient.status)}</span>
          </li>)}</ul></div>}
        <p className="text-xs text-slate-500">{queue.updatedAt ? `Updated ${new Date(queue.updatedAt).toLocaleTimeString()}` : ""} · Tokens are never renumbered</p>
        <div className="flex gap-2">{cursor && <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={resetView}>First page</Button>}
          {data.nextCursor && <Button type="button" size="sm" variant="outline" disabled={disabled || !!confirmation} onClick={() => { setCursor(data.nextCursor!); setConfirmation(null); }}>Next page</Button>}</div>
      </div>
    </>}
  </section>;
}
