"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, RefreshCw, Search, Ticket, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkInPatient, completeQueueConsultation, markPatientAbsent, QueueApiError, readDailyQueue, readQueueAssignments, startNextPatient } from "@/lib/queue-api";
import { attendanceLabel, consultationDuration, localQueueDate, matchesQueueSearch, queueTimeRange } from "@/lib/queue-response";
import { useQueueResource } from "./use-appointment-queue";
import { DoctorPatientProfile } from "./doctor-patient-profile";

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
  const [search, setSearch] = useState("");
  const [staffView, setStaffView] = useState<"arrivals" | "waiting" | "closed">("arrivals");
  const [confirmation, setConfirmation] = useState<{ kind: "absent" | "complete"; id: string; name: string } | null>(null);
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
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
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
  const visibleExpected = data?.expected.filter(patient => matchesQueueSearch(patient, search)) ?? [];
  const visibleWaiting = data?.waiting.filter(patient => matchesQueueSearch(patient, search)) ?? [];
  const visibleClosed = data?.closed.filter(patient => matchesQueueSearch(patient, search)) ?? [];

  async function act<T>(label: string, command: (signal: AbortSignal) => Promise<T>, successMessage?: (result: T) => string) {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(label); setError(""); setNotice("");
    try {
      const result = await command(controller.signal);
      if (controller.signal.aborted) return;
      setConfirmation(null); setNotice(successMessage ? successMessage(result) : `${label} completed. Refreshing the queue.`);
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
  function resetView() { setCursor(undefined); setConfirmation(null); setError(""); setNotice(""); setSearch(""); }

  return <section aria-label="Patient check-in and queue" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="flex items-center gap-2 font-bold text-slate-900"><Users className="size-5 text-teal-700" aria-hidden="true" />Patient queue</h3>
        <p className="mt-1 text-xs text-slate-500">{date} · {data?.timezone ?? zone} · Refreshes while this tab is visible</p></div>
      <span ref={refreshControl}><Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => { assignments.refresh(); queue.refresh(); }}><RefreshCw className="mr-1.5 size-4" aria-hidden="true" />Refresh queue</Button></span>
    </div>
    <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
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
    {confirmation && <div ref={confirmationPanel} tabIndex={-1} role="alertdialog" aria-label={confirmation.kind === "complete" ? "Confirm consultation completion" : "Confirm patient absence"} aria-describedby="queue-confirm-description" className="rounded-xl border border-amber-300 bg-amber-50 p-4 focus-visible:outline-2 focus-visible:outline-teal-700">
      <p id="queue-confirm-description" className="text-sm font-semibold text-amber-950">{confirmation.kind === "complete" ? `Complete the consultation for ${confirmation.name}?` : `Mark ${confirmation.name} as absent? This does not cancel or refund the booking.`}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" disabled={disabled} onClick={() => void act(confirmation.kind === "complete" ? "Consultation completion" : "No-show update", signal => confirmation.kind === "complete" ? completeQueueConsultation(confirmation.id, signal) : markPatientAbsent(confirmation.id, signal))}>
        {busy || (confirmation.kind === "complete" ? "Confirm completion" : "Confirm absence")}</Button>
        <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => { setConfirmation(null); requestAnimationFrame(() => { const target = confirmationTrigger.current; if (target?.isConnected) target.focus(); else refreshControl.current?.querySelector("button")?.focus(); }); }}>Keep unchanged</Button></div>
    </div>}
    {data && <>
      {role === "staff" && <>
        <div className="grid gap-3 sm:grid-cols-3" aria-label="Reception queue summary">
          <div className="rounded-2xl border border-teal-200 bg-teal-50 p-5"><p className="flex items-center gap-2 text-sm font-semibold text-teal-900"><Ticket className="size-4" aria-hidden="true" />Current token</p><p className="mt-2 text-4xl font-bold tracking-tight text-teal-950">{data.current ? `#${data.current.tokenNumber}` : "—"}</p><p className="mt-2 text-xs text-teal-800">{data.current ? "Currently with the doctor" : "No active consultation"}</p></div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5"><p className="flex items-center gap-2 text-sm font-semibold text-amber-900"><Users className="size-4" aria-hidden="true" />Remaining patients</p><p className="mt-2 text-4xl font-bold tracking-tight text-amber-950">{data.waitingCount}</p><p className="mt-2 text-xs text-amber-800">Checked in and waiting, excluding the current patient</p></div>
          <div className="rounded-2xl border border-blue-100 bg-blue-50 p-5"><p className="text-sm font-semibold text-blue-800">Arrivals on this page</p><p className="mt-2 text-4xl font-bold tracking-tight text-slate-950">{data.expected.length}{data.hasMoreExpected ? "+" : ""}</p><p className="mt-2 text-xs text-slate-600">Booked, awaiting check-in</p></div>
        </div>
        <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1" role="group" aria-label="Reception views">
            {([ ["arrivals", "Arrivals & check-in"], ["waiting", "Waiting queue"], ["closed", "Closed visits"] ] as const).map(([view, label]) => <button key={view} type="button" aria-pressed={staffView === view} onClick={() => setStaffView(view)} className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-teal-700 ${staffView === view ? "bg-white text-teal-900 shadow-sm" : "text-slate-600 hover:text-slate-950"}`}>{label}</button>)}
          </div>
          <label className="relative block lg:w-72"><span className="sr-only">Search patients on this page by name or token</span><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-slate-400" aria-hidden="true" /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Patient name or #token" className="min-h-11 w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-teal-700" /></label>
        </div>
        <p className="text-xs text-slate-500">Search applies to the current page. Tokens identify bookings; queue positions follow check-in order. Use Next page for more records.</p>
      </>}
      <div className="rounded-2xl border border-teal-200 bg-teal-50 p-4 sm:p-5">
        <p className="text-xs font-bold uppercase tracking-wide text-teal-800">Currently attending</p>
        {data.current ? <div className="mt-2 space-y-2"><p className="break-words text-lg font-bold text-slate-950">{data.current.patientName}</p>
          <p className="text-sm text-teal-950">Token <strong>{data.current.tokenNumber}</strong> · {queueTimeRange(data.current.startsAt, data.current.endsAt, data.current.timezone)} · {data.current.serviceDate}</p>
          <p className="text-sm text-teal-950">Started at {new Intl.DateTimeFormat("en-IN", { timeZone: data.current.timezone, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(data.current.startedAt))} · Elapsed {consultationDuration(data.current.startedAt, clock)}</p>
          {role === "doctor" && <><DoctorPatientProfile appointmentId={data.current.appointmentId} patientName={data.current.patientName} /><div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled || !!confirmation} onClick={() => setConfirmation({ kind: "complete", id: data.current!.appointmentId, name: data.current!.patientName })}><CheckCircle2 className="mr-2 size-4" aria-hidden="true" />Complete consultation</Button></div></>}
        </div> : <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-600">No consultation is currently active.</p>
          {role === "doctor" && <Button type="button" disabled={disabled || !!confirmation || !!cursor || !data.waitingCount} onClick={() => void act("Consultation start", signal => startNextPatient(doctorId, date, data.version, signal))}>Start next patient</Button>}</div>}
      </div>
      {(role === "doctor" || staffView === "waiting") && <div><h4 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-900"><Clock className="size-4 text-teal-700" aria-hidden="true" />Checked in · {data.waitingCount} waiting</h4>
        {!visibleWaiting.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">{search ? "No matching checked-in patients on this page." : "No checked-in patients on this page."}</p>}
        <ol className="space-y-2">{visibleWaiting.map(patient => <li key={patient.appointmentId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="min-w-0"><p className="break-words font-semibold text-slate-900">{patient.patientName}</p><p className="mt-1 text-xs text-slate-500">{queueTimeRange(patient.startsAt, patient.endsAt, data.timezone)}</p></div>
          <div className="flex flex-wrap items-center gap-3 text-sm"><span className="rounded-lg bg-teal-50 px-3 py-1 text-teal-950">Token <strong>{patient.tokenNumber}</strong></span><span className="text-slate-600">Position <strong>{patient.position}</strong></span></div>
          {role === "doctor" && <DoctorPatientProfile appointmentId={patient.appointmentId} patientName={patient.patientName} />}
        </li>)}</ol>
      </div>}
      {(role === "doctor" || staffView === "arrivals") && <div><h4 className="mb-3 text-sm font-bold text-slate-900">Expected arrivals</h4>
        {!visibleExpected.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">{search ? "No matching arrivals on this page. Try another name or token." : "No patients awaiting check-in on this page."}</p>}
        <ul className="space-y-3">{visibleExpected.map(patient => <li key={patient.appointmentId} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5">
          <div className="flex min-w-0 items-center gap-3"><span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-lg font-bold text-teal-900" aria-label={`Booking token ${patient.tokenNumber ?? "unavailable"}`}>{patient.tokenNumber ? `#${patient.tokenNumber}` : <Ticket className="size-5" aria-hidden="true" />}</span><div className="min-w-0"><p className="break-words font-semibold text-slate-900">{patient.patientName}</p><p className="mt-1 text-xs text-slate-500">{queueTimeRange(patient.startsAt, patient.endsAt, data.timezone)}</p><p className="mt-1 text-xs font-medium text-blue-700">Not checked in · No queue position yet</p></div></div>
          {role === "doctor" && <DoctorPatientProfile appointmentId={patient.appointmentId} patientName={patient.patientName} />}
          <div className="flex flex-wrap gap-2"><Button type="button" className="min-h-11" disabled={disabled || !!confirmation || date !== today} aria-label={`Check in ${patient.patientName}`} onClick={() => void act("Patient check-in", signal => checkInPatient(patient.appointmentId, signal), result => `${patient.patientName} checked in. Token #${result.tokenNumber} retained. Queue position ${result.position ?? "updating"}.`)}>Check in</Button>
            {role === "staff" && <Button type="button" variant="outline" className="min-h-11" disabled={disabled || !!confirmation || Date.parse(patient.startsAt) > clock} aria-label={`Mark ${patient.patientName} absent`} onClick={() => setConfirmation({ kind: "absent", id: patient.appointmentId, name: patient.patientName })}>Mark absent</Button>}</div>
        </li>)}</ul>
      </div>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        {(role === "doctor" && data.closed.length > 0 || role === "staff" && staffView === "closed") && <div className="w-full"><h4 className="mb-2 text-sm font-bold text-slate-900">Completed and closed visits</h4>
          {!visibleClosed.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">{search ? "No matching closed visits on this page." : "No closed visits on this page."}</p>}
          <ul className="space-y-2">{visibleClosed.map(patient => <li key={patient.appointmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
            <span className="break-words font-medium">{patient.patientName}{patient.tokenNumber !== null ? ` · Token ${patient.tokenNumber}` : ""}</span>
            <span className="text-slate-600">{attendanceLabel(patient.status)}</span>
            {role === "doctor" && patient.status === "completed" && <DoctorPatientProfile appointmentId={patient.appointmentId} patientName={patient.patientName} />}
            {patient.status === "completed" && patient.startedAt && <p className="w-full text-xs text-slate-600">Consultation: {queueTimeRange(patient.startedAt, patient.terminalAt, data.timezone)} · Duration {consultationDuration(patient.startedAt, patient.terminalAt)} ({data.timezone})</p>}
          </li>)}</ul></div>}
        <p className="text-xs text-slate-500">{queue.updatedAt ? `Updated ${new Date(queue.updatedAt).toLocaleTimeString()}` : ""} · Tokens are never renumbered</p>
        <div className="flex gap-2">{cursor && <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={resetView}>First page</Button>}
          {data.nextCursor && <Button type="button" size="sm" variant="outline" disabled={disabled || !!confirmation} onClick={() => { setCursor(data.nextCursor!); setConfirmation(null); }}>Next page</Button>}</div>
      </div>
    </>}
  </section>;
}
