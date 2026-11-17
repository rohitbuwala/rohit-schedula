"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQueueResource } from "@/components/use-appointment-queue";
import { approveStaff, readPendingStaff, assignStaffDoctor, createStaffAccount, findStaffCandidate, provisionStaff, readAssignableDoctors, readStaffAssignments, readStaffPage, revokeStaffDoctor,
  type StaffAccount, type StaffCandidate, type StaffAssignment } from "@/lib/staff-access-api";

export function AdminStaffAssignments() {
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<StaffAccount | null>(null);
  const [doctorSelection, setDoctorSelection] = useState("");
  const [email, setEmail] = useState("");
  const [candidate, setCandidate] = useState<StaffCandidate | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revoking, setRevoking] = useState<StaffAssignment | null>(null);
  const action = useRef<AbortController | null>(null);
  const confirmPanel = useRef<HTMLDivElement>(null);
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => { if (revoking) { confirmPanel.current?.focus(); confirmPanel.current?.scrollIntoView({ block: "nearest" }); } }, [revoking]);
  const loadPage = useCallback((signal: AbortSignal) => readStaffPage(offset, signal), [offset]);
  const page = useQueueResource(`staff-page:${offset}`, loadPage);
  const loadDoctors = useCallback((signal: AbortSignal) => readAssignableDoctors(signal), []);
  const doctors = useQueueResource("assignable-doctors", loadDoctors);
  const pending = useQueueResource("pending-staff", readPendingStaff);
  const staff = selection ?? page.data?.items[0] ?? null;
  const staffId = staff?.id ?? "";
  const loadAssignments = useCallback((signal: AbortSignal) => readStaffAssignments(staffId, signal), [staffId]);
  const assignments = useQueueResource(staffId ? `staff-assignments:${staffId}` : "", loadAssignments);
  const accounts = selection && !page.data?.items.some(item => item.id === selection.id) ? [selection, ...page.data?.items ?? []] : page.data?.items ?? [];
  const available = doctors.data?.filter(doctor => !assignments.data?.some(item => item.doctorId === doctor.doctorId && !item.revokedAt)) ?? [];
  const doctorId = available.some(item => item.doctorId === doctorSelection) ? doctorSelection : available[0]?.doctorId ?? "";
  const unavailable = !!page.error || !!doctors.error || !!assignments.error || page.loading || doctors.loading || assignments.loading;
  const staffPending = pending.data?.some(item => item.id === staffId);
  const disabled = !!busy || unavailable || !!pending.error || pending.loading || !!staffPending;
  const doctorName = (id: string) => doctors.data?.find(item => item.doctorId === id)?.name ?? "Previously assigned doctor";

  async function run(label: string, command: (signal: AbortSignal) => Promise<unknown>) {
    if (action.current) return;
    const controller = new AbortController(); action.current = controller;
    setBusy(label); setError(""); setNotice("");
    try {
      await command(controller.signal);
      if (!controller.signal.aborted) { setNotice(label); setRevoking(null); window.dispatchEvent(new Event("queue-updated")); }
    } catch (cause) {
      if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "The action could not be confirmed. Refresh before retrying."); page.refresh(); assignments.refresh(); }
    } finally { if (action.current === controller) { action.current = null; if (!controller.signal.aborted) setBusy(""); } }
  }

  return <section aria-label="Staff access management" className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8">
    <header className="flex flex-wrap items-start justify-between gap-3"><div>
      <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-950"><ShieldCheck className="size-6 text-teal-700" aria-hidden="true" />Staff access</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">Enable dedicated staff accounts and assign the doctors they support. Staff can manage arrivals, but cannot open medical records or complete consultations.</p>
    </div><Button type="button" variant="outline" disabled={!!busy} onClick={() => { page.refresh(); doctors.refresh(); assignments.refresh(); }}><RefreshCw className="size-4" aria-hidden="true" />Refresh access</Button></header>
    {(error || page.error || doctors.error || assignments.error) && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error || page.error || doctors.error || assignments.error}</p>}
    {notice && <p role="status" className="rounded-xl bg-teal-50 p-3 text-sm text-teal-950">{notice}</p>}
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <h2 className="font-bold text-slate-900">Staff registration requests</h2>
      {pending.loading && <p role="status" className="mt-3 text-sm">Loading requests…</p>}
      {pending.error && <p role="alert" className="mt-3 text-sm text-rose-800">{pending.error}<button type="button" className="ml-2 underline" onClick={pending.refresh}>Retry</button></p>}
      {pending.data?.length === 0 && <p className="mt-3 text-sm text-slate-600">No pending staff requests.</p>}
      <ul className="mt-3 space-y-3">{pending.data?.map(request => <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
        <div><p className="break-words font-semibold">{request.name}</p><p className="break-all text-sm text-slate-600">{request.email}</p><p className="text-xs text-amber-800">Waiting for approval</p></div>
        <Button type="button" disabled={!!busy} onClick={() => void run("Staff registration approved. Assign a doctor below.", async signal => { await approveStaff(request.id, signal); if (!signal.aborted) setSelection({ id: request.id, name: request.name, email: request.email, role: "staff" }); })}>Approve {request.name}</Button>
      </li>)}</ul>
      {pending.data?.length === 50 && <p className="mt-3 text-xs text-slate-600">Showing the oldest 50 requests. More appear as you approve these.</p>}
    </div>

    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <h2 className="font-bold text-slate-900">Create staff account</h2>
      <p className="mt-2 text-sm text-slate-600">Create staff here using a new email address, then assign a doctor below. Staff sign in through the normal login page.</p>
      <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
        const input = { name: String(values.get("staffName")).trim(), email: String(values.get("staffEmail")).trim().toLowerCase(), password: String(values.get("staffPassword")) };
        void run("Staff account created. Assign a doctor below, then ask the staff member to sign in.", async signal => {
          const saved = await createStaffAccount(input, signal);
          if (!signal.aborted) { setSelection(saved); setOffset(0); form.reset(); }
        });
      }}>
        <label className="text-sm font-medium text-slate-700">Staff name<input name="staffName" required maxLength={100} autoComplete="off" disabled={!!busy} className="mt-1 block w-full rounded-lg border border-slate-300 p-2.5" /></label>
        <label className="text-sm font-medium text-slate-700">Staff email<input name="staffEmail" type="email" required maxLength={254} autoComplete="off" disabled={!!busy} className="mt-1 block w-full rounded-lg border border-slate-300 p-2.5" /></label>
        <label className="text-sm font-medium text-slate-700">Password<input name="staffPassword" type="password" required minLength={8} maxLength={128} autoComplete="new-password" disabled={!!busy} className="mt-1 block w-full rounded-lg border border-slate-300 p-2.5" /></label>
        <div className="self-end"><Button type="submit" disabled={!!busy || !!page.error || page.loading}>Create staff account</Button></div>
      </form>
    </div>

    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <h2 className="flex items-center gap-2 font-bold text-slate-900"><UserPlus className="size-5 text-teal-700" aria-hidden="true" />Enable a staff account</h2>
      <p className="mt-2 text-sm text-slate-600">Find an existing dedicated account by email. Accounts with patient records, appointments or doctor applications cannot be converted.</p>
      <form className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-end" onSubmit={event => { event.preventDefault(); setCandidate(null); setConfirmed(false); void run("Account lookup completed.", async signal => { const result = await findStaffCandidate(email, signal); if (!signal.aborted) setCandidate(result); }); }}>
        <label className="w-full text-sm font-medium text-slate-700 sm:max-w-md">Account email
          <input type="email" required maxLength={254} value={email} disabled={!!busy} onChange={event => { setEmail(event.target.value); setCandidate(null); setConfirmed(false); }} className="mt-1 block w-full rounded-lg border border-slate-300 p-2.5" /></label>
        <Button type="submit" disabled={!!busy || !!page.error || page.loading}>Find account</Button>
      </form>
      {candidate && !page.error && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="break-words font-semibold text-slate-900">{candidate.name}</p><p className="break-all text-sm text-slate-600">{candidate.email}</p>
        {!candidate.eligible ? <p className="mt-2 text-sm text-amber-900">This account has a protected role or patient/doctor records and cannot be converted. Use Create staff account above with a different email.</p>
          : candidate.role === "staff" ? <Button type="button" className="mt-3" disabled={!!busy} onClick={() => setSelection({ ...candidate, role: "staff" })}>Use this staff account</Button>
            : <div className="mt-3 space-y-3"><p className="text-sm font-medium text-teal-800">Account available for staff access.</p>
              <label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)} className="mt-1 size-4" />I confirm this dedicated account should become a staff account.</label>
              <Button type="button" disabled={!!busy || !confirmed} onClick={() => void run("Staff access enabled. Ask the staff member to sign in again.", async signal => {
                const saved = await provisionStaff(candidate.id, signal); if (!signal.aborted) { setSelection(saved); setOffset(0); setCandidate({ ...saved, eligible: true, reason: "already_staff" }); setConfirmed(false); }
              })}>Enable staff access</Button></div>}
      </div>}
    </div>

    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <h2 className="font-bold text-slate-900">Doctor assignments</h2>
      {staffPending && <p className="mt-3 text-sm text-amber-900">Approve this staff member’s registration above before assigning a doctor.</p>}
      {page.loading && <p role="status" className="mt-3 text-sm text-slate-500">Loading staff accounts…</p>}
      {page.data && accounts.length === 0 && <p className="mt-3 text-sm text-slate-600">No staff accounts on this page. Enable a dedicated account above.</p>}
      {!!accounts.length && <label className="mt-4 block max-w-xl text-sm font-medium text-slate-700">Staff member
        <select aria-label="Staff member" value={staffId} disabled={!!busy || !!revoking} onChange={event => { setSelection(accounts.find(item => item.id === event.target.value) ?? null); setError(""); setNotice(""); }} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2.5">
          {accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.email}</option>)}
        </select></label>}
      <div className="mt-3 flex flex-wrap gap-2">{offset > 0 && <Button type="button" variant="outline" size="sm" disabled={!!busy || !!revoking} onClick={() => { setSelection(null); setOffset(value => Math.max(0, value - 50)); }}>Previous staff page</Button>}
        {page.data?.hasNext && <Button type="button" variant="outline" size="sm" disabled={disabled || !!revoking} onClick={() => { setSelection(null); setOffset(value => value + 50); }}>Next staff page</Button>}</div>
      {staff && <>
        <form className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-end" onSubmit={event => { event.preventDefault(); if (doctorId && !disabled) void run("Doctor assignment saved.", signal => assignStaffDoctor(staffId, doctorId, signal)); }}>
          <label className="w-full text-sm font-medium text-slate-700 sm:max-w-md">Approved doctor
            <select aria-label="Assign doctor" value={doctorId} disabled={disabled || !!revoking} onChange={event => setDoctorSelection(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2.5">
              {!available.length && <option value="">No unassigned approved doctors</option>}
              {available.map(doctor => <option key={doctor.doctorId} value={doctor.doctorId}>{doctor.name} · {doctor.specialty}</option>)}
            </select></label><Button type="submit" disabled={disabled || !!revoking || !doctorId}>Assign doctor</Button>
        </form>
        {assignments.loading && <p role="status" className="mt-4 text-sm text-slate-500">Loading assignments…</p>}
        {assignments.data?.length === 0 && <p className="mt-4 text-sm text-slate-500">No doctors have been assigned to this staff member.</p>}
        {revoking && <div ref={confirmPanel} tabIndex={-1} role="alertdialog" aria-label="Confirm access revocation" aria-describedby="staff-revoke-description" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p id="staff-revoke-description" className="text-sm text-amber-950">Revoke {staff.name}’s access to {doctorName(revoking.doctorId)}?</p>
          <div className="mt-3 flex flex-wrap gap-2"><Button type="button" disabled={disabled} onClick={() => void run("Doctor assignment revoked.", signal => revokeStaffDoctor(staffId, revoking.doctorId, signal))}>Confirm revocation</Button>
            <Button type="button" variant="outline" disabled={!!busy} onClick={() => setRevoking(null)}>Keep access</Button></div>
        </div>}
        <ul className="mt-4 space-y-2">{assignments.data?.map(assignment => <li key={assignment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-4">
          <div><p className="font-semibold text-slate-900">{doctorName(assignment.doctorId)}</p><p className="mt-1 text-xs text-slate-500">{assignment.revokedAt ? "Revoked" : "Active assignment"}</p></div>
          <Button type="button" size="sm" variant="outline" disabled={disabled || !!revoking || !!assignment.revokedAt && !doctors.data?.some(doctor => doctor.doctorId === assignment.doctorId)} onClick={() => assignment.revokedAt
            ? void run("Doctor assignment restored.", signal => assignStaffDoctor(staffId, assignment.doctorId, signal)) : setRevoking(assignment)}>{assignment.revokedAt ? "Restore assignment" : "Revoke access"}</Button>
        </li>)}</ul>
      </>}
    </div>
  </section>;
}
