"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { backendUrl } from "@/lib/api";
import { CalendarDays, ClipboardList, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

const visitSchema = z.object({ id: z.string(), startsAt: z.string(), status: z.string(), attendanceStatus: z.string().nullable(),
  doctorName: z.string(), specialty: z.string().nullable(), notes: z.string().nullable(), details: z.string().nullable() });
const editorSchema = z.object({ notes: z.string(), details: z.string(), revision: z.number().int().nonnegative() });
type Visit = z.infer<typeof visitSchema>;

export function VisitHistory({ appointmentId }: { appointmentId?: string }) {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [editor, setEditor] = useState<z.infer<typeof editorSchema> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const historyUrl = appointmentId ? `/api/appointments/${encodeURIComponent(appointmentId)}/patient/visits` : "/api/appointments/me/visits";
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const history = await fetch(`${backendUrl}${historyUrl}`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!history.ok) throw new Error("Could not load visit history.");
        const parsed = z.array(visitSchema).parse(await history.json());
        let visit = null;
        if (appointmentId) {
          const response = await fetch(`${backendUrl}/api/appointments/${encodeURIComponent(appointmentId)}/visit`, { credentials: "include", cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("Could not load visit details.");
          visit = editorSchema.parse(await response.json());
        }
        if (!controller.signal.aborted) { setVisits(parsed); setEditor(visit); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load visit history."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [appointmentId, historyUrl, refresh]);

  async function save() {
    if (!appointmentId || !editor || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch(`${backendUrl}/api/appointments/${encodeURIComponent(appointmentId)}/visit`, { method: "PATCH", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(editor) });
      if (response.status === 409) throw new Error("Visit details changed. Reload before saving.");
      if (!response.ok) throw new Error("Could not save visit details.");
      setEditor(editorSchema.parse(await response.json())); setSaved(true);
      setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save visit details."); }
    finally { setBusy(false); }
  }

  return <section aria-label="Visit history" className="mt-5 space-y-5 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm sm:p-6">
    <div className="flex items-start gap-3"><div className="rounded-xl bg-teal-50 p-2.5 text-teal-700"><ClipboardList className="h-5 w-5" /></div><div><h3 className="text-base font-bold text-slate-900">Visit history</h3><p className="mt-1 text-slate-500">Consultation records and details in one place.</p></div></div>
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-700">{error}</p>}
    {saved && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">Visit details saved successfully.</p>}
    {loading && <p role="status" className="text-slate-500">Loading visits...</p>}
    {appointmentId && editor && <div className="space-y-4 rounded-xl border border-teal-100 bg-teal-50/40 p-4 sm:p-5">
      <div><h4 className="font-bold text-slate-900">Current appointment details</h4><p className="mt-1 text-xs text-slate-500">Document the consultation and relevant visit details.</p></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block font-semibold text-slate-700">Consultation notes<textarea className="mt-2 block min-h-28 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100" maxLength={5000} placeholder="Add consultation notes" value={editor.notes} onChange={event => { setSaved(false); setEditor({ ...editor, notes: event.target.value }); }} /></label>
        <label className="block font-semibold text-slate-700">Visit details<textarea className="mt-2 block min-h-28 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100" maxLength={5000} placeholder="Add visit details" value={editor.details} onChange={event => { setSaved(false); setEditor({ ...editor, details: event.target.value }); }} /></label>
      </div>
      <p className="text-xs text-slate-600">The patient and authorized treating doctors can view these details.</p>
      <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving..." : "Save visit details"}</Button>
    </div>}
    {!loading && !error && visits.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center"><CalendarDays className="mx-auto h-6 w-6 text-teal-600" /><p className="mt-2 font-semibold text-slate-700">No previous visits</p><p className="mt-1 text-xs text-slate-500">Visit records will appear here when available.</p></div>}
    <ol className="space-y-3">{visits.map(visit => <li key={visit.id} className="rounded-xl border border-slate-200 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3"><div><p className="flex items-center gap-2 font-semibold text-slate-900"><CalendarDays className="h-4 w-4 text-teal-600" />{new Date(visit.startsAt).toLocaleString()}</p><p className="mt-1 text-slate-600">Dr. {visit.doctorName} · {visit.specialty || "Specialty not provided"}</p></div><span className="rounded-full bg-teal-50 px-3 py-1 text-xs font-semibold capitalize text-teal-800">{(visit.attendanceStatus || visit.status).replace(/_/g, " ")}</span></div>
      <div className="grid gap-4 pt-3 sm:grid-cols-2">{[["Consultation notes", visit.notes], ["Visit details", visit.details]].map(([label, value]) => <div key={label}><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-slate-700">{value || "Not provided"}</p></div>)}</div>
    </li>)}</ol>
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setLoading(true); setRefresh(value => value + 1); }}><RefreshCw className="mr-2 h-4 w-4" />Reload visits</Button>
  </section>;
}
