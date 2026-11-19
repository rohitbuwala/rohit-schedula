"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { backendUrl } from "@/lib/api";
import { patientAge } from "@/lib/patient-age";
import { Button } from "@/components/ui/button";

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
    {open && <section aria-label={`Patient profile for ${patientName}`} className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      {error ? <p role="alert" className="text-rose-700">{error}</p> : !fields ? <p role="status">Loading patient profile...</p> :
        <><dl className="grid gap-3 sm:grid-cols-2">{fields.map(([label, value]) => <div key={label}><dt className="font-semibold text-slate-600">{label}</dt><dd className="break-words text-slate-900">{value?.trim() || "Not provided"}</dd></div>)}</dl><MedicalInformation appointmentId={appointmentId} onSaved={allergies => setProfile(current => current ? { ...current, allergies } : current)} /></>}
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
    setBusy(true); setError("");
    try {
      const response = await fetch(url, { method: "PATCH", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allergies: allergies.trim() || null, conditions: conditions.trim() || null, revision: data.revision }) });
      if (response.status === 409) throw new Error("Medical information changed. Reload to see the latest information before saving.");
      if (!response.ok) throw new Error("Could not save medical information.");
      const value = medicalSchema.parse(await response.json());
      setData(value); setAllergies(value.allergies ?? ""); setConditions(value.conditions ?? ""); onSaved?.(value.allergies);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save medical information."); }
    finally { setBusy(false); }
  }
  return <section className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm" aria-label="Medical information">
    <h3 className="font-bold">Medical information</h3>
    {error && <p role="alert" className="text-rose-700">{error}</p>}
    {!data ? <p role="status">{error ? "Medical information is unavailable." : "Loading medical information..."}</p> : <>
      <label className="block font-semibold">Allergies<textarea className="mt-1 block w-full rounded border p-2 font-normal" value={allergies} maxLength={500} onChange={event => setAllergies(event.target.value)} /></label>
      <label className="block font-semibold">Existing conditions<textarea className="mt-1 block w-full rounded border p-2 font-normal" value={conditions} maxLength={500} onChange={event => setConditions(event.target.value)} /></label>
      <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving..." : "Save medical information"}</Button>
      <h4 className="font-semibold">Update history</h4>
      <p className="text-xs text-slate-600">History includes changes made after this feature was enabled.</p>
      {!data.history.length ? <p>No medical updates recorded.</p> : <ol className="space-y-2">{data.history.map(entry => <li key={entry.id} className="rounded border p-2">
        <p>{entry.actorName} ({entry.actorRole}) · {new Date(entry.createdAt).toLocaleString()}</p>
        {Object.entries(entry.changes).map(([field, change]) => <p key={field}>{field}: {change.before || "Not provided"} → {change.after || "Not provided"}</p>)}
      </li>)}</ol>}
    </>}
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setReload(value => value + 1)}>Reload medical information</Button>
  </section>;
}
