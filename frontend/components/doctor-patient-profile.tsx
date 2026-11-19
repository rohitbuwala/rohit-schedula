"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { backendUrl } from "@/lib/api";
import { patientAge } from "@/lib/patient-age";
import { Activity, HeartPulse, RefreshCw, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VisitHistory } from "@/components/visit-history";

const profileSchema = z.object({
  name: z.string(), dateOfBirth: z.string().nullable(), gender: z.string().nullable(),
  bloodGroup: z.string().nullable(), phone: z.string().nullable(),
  address: z.string().nullable(), allergies: z.string().nullable(),
});
type Profile = z.infer<typeof profileSchema>;

export function DoctorPatientProfile({ appointmentId, patientName }: { appointmentId: string; patientName: string }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`${backendUrl}/api/appointments/${encodeURIComponent(appointmentId)}/patient`, {
          credentials: "include", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Unable to load this patient profile. Please refresh and try again.");
        const data = profileSchema.parse(await response.json());
        if (!controller.signal.aborted) setProfile(data);
      } catch {
        if (!controller.signal.aborted) setError("Unable to load this patient profile. Please refresh and try again.");
      }
    }
    void load();
    return () => controller.abort();
  }, [appointmentId, open]);

  function toggle() { setProfile(null); setError(""); setOpen(!open); }
  const fields = profile && [
    ["Name", profile.name], ["Age", patientAge(profile.dateOfBirth)],
    ["Gender", profile.gender === "prefer_not_to_say" ? "Prefer not to say" : profile.gender],
    ["Blood group", profile.bloodGroup], ["Phone", profile.phone],
    ["Address", profile.address], ["Allergies", profile.allergies],
  ];

  return <div className="w-full space-y-2">
    <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-label={`${open ? "Hide" : "View"} patient profile for ${patientName}`} onClick={toggle}>
      {open ? "Hide Patient Profile" : "View Patient Profile"}
    </Button>
    {open && <section aria-label={`Patient profile for ${patientName}`} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 text-sm sm:p-5">
      {error ? <p role="alert" className="text-rose-700">{error}</p> : !fields ? <p role="status">Loading patient profile...</p> :
        <><div className="mb-4 flex items-center gap-3"><div className="rounded-xl bg-teal-100 p-2.5 text-teal-700"><UserRound className="h-5 w-5" /></div><div><h3 className="text-base font-bold text-slate-900">Patient profile</h3><p className="text-xs text-slate-500">Personal and contact details</p></div></div><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([label, value]) => <div key={label} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words font-medium text-slate-900">{value?.trim() || "Not provided"}</dd></div>)}</dl><MedicalInformation appointmentId={appointmentId} onSaved={allergies => setProfile(current => current ? { ...current, allergies } : current)} /><VisitHistory appointmentId={appointmentId} /></>}
    </section>}
  </div>;
}

const medicalSchema = z.object({ allergies: z.string().nullable(), conditions: z.string().nullable(), revision: z.number().int().nonnegative(),
  history: z.array(z.object({ id: z.string(), actorName: z.string(), actorRole: z.string(), createdAt: z.string(),
    changes: z.record(z.string(), z.object({ before: z.string().nullable(), after: z.string().nullable() })) })) });
type Medical = z.infer<typeof medicalSchema>;

export function MedicalInformation({ appointmentId, onSaved }: { appointmentId?: string; onSaved?: (allergies: string | null) => void }) {
  const [data, setData] = useState<Medical | null>(null);
  const [allergies, setAllergies] = useState("");
  const [conditions, setConditions] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const url = `${backendUrl}/api/patients/${appointmentId ? `appointments/${encodeURIComponent(appointmentId)}` : "me"}/medical`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return medicalSchema.parse(await response.json()); })
      .then(value => { setData(value); setAllergies(value.allergies ?? ""); setConditions(value.conditions ?? ""); setError(""); })
      .catch(() => { if (!controller.signal.aborted) setError("Could not load medical information."); });
    return () => controller.abort();
  }, [url, reload]);
  async function save() {
    if (!data || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch(url, { method: "PATCH", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allergies: allergies.trim() || null, conditions: conditions.trim() || null, revision: data.revision }) });
      if (response.status === 409) throw new Error("Medical information changed. Reload to see the latest information before saving.");
      if (!response.ok) throw new Error("Could not save medical information.");
      const value = medicalSchema.parse(await response.json());
      setData(value); setAllergies(value.allergies ?? ""); setConditions(value.conditions ?? ""); onSaved?.(value.allergies); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save medical information."); }
    finally { setBusy(false); }
  }
  return <section className="mt-4 space-y-5 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm sm:p-6" aria-label="Medical information">
    <div className="flex items-start gap-3"><div className="rounded-xl bg-teal-50 p-2.5 text-teal-700"><HeartPulse className="h-5 w-5" /></div><div><h3 className="text-base font-bold text-slate-900">Medical information</h3><p className="mt-1 text-slate-500">Keep important health information up to date.</p></div></div>
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-700">{error}</p>}
    {saved && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">Medical information saved successfully.</p>}
    {!data ? <p role="status" className="text-slate-500">{error ? "Medical information is unavailable." : "Loading medical information..."}</p> : <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block rounded-xl border border-slate-200 bg-slate-50 p-4 font-semibold text-slate-800">Allergies<span className="mt-1 block text-xs font-normal text-slate-500">Medicines, foods, or other known allergies</span><textarea className="mt-3 block min-h-24 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100" placeholder="Add known allergies" value={allergies} maxLength={500} onChange={event => { setSaved(false); setAllergies(event.target.value); }} /></label>
        <label className="block rounded-xl border border-slate-200 bg-slate-50 p-4 font-semibold text-slate-800">Existing conditions<span className="mt-1 block text-xs font-normal text-slate-500">Relevant ongoing medical conditions</span><textarea className="mt-3 block min-h-24 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100" placeholder="Add medical conditions" value={conditions} maxLength={500} onChange={event => { setSaved(false); setConditions(event.target.value); }} /></label>
      </div>
      <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving..." : "Save medical information"}</Button>
      <div className="border-t border-slate-100 pt-4"><h4 className="flex items-center gap-2 font-bold text-slate-900"><Activity className="h-4 w-4 text-teal-600" />Update history</h4><p className="mt-1 text-xs text-slate-500">History includes changes made after this feature was enabled.</p></div>
      {!data.history.length ? <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-slate-500">No medical updates recorded yet.</p> : <ol className="space-y-3">{data.history.map(entry => <li key={entry.id} className="rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap justify-between gap-2"><p className="font-semibold text-slate-800">{entry.actorName} <span className="font-normal capitalize text-slate-500">({entry.actorRole})</span></p><time className="text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</time></div>
        <div className="mt-3 space-y-2">{Object.entries(entry.changes).map(([field, change]) => <div key={field} className="rounded-lg bg-slate-50 p-3"><p className="font-semibold capitalize text-slate-700">{field.replace(/_/g, " ")}</p><p className="mt-1 whitespace-pre-wrap break-words text-slate-600"><span className="text-slate-500">From:</span> {change.before || "Not provided"}</p><p className="mt-1 whitespace-pre-wrap break-words text-slate-700"><span className="text-slate-500">To:</span> {change.after || "Not provided"}</p></div>)}</div>
      </li>)}</ol>}
    </>}
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setSaved(false); setReload(value => value + 1); }}><RefreshCw className="mr-2 h-4 w-4" />Reload medical information</Button>
  </section>;
}
