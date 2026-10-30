"use client";

import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { backendUrl } from "@/lib/api";
import { patientProfileFormSchema } from "@/lib/patient-profile-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type PatientProfileData = { id: string; name: string; email: string; image: string | null };
const patientProfileResponseSchema = z.object({ id: z.string(), name: z.string(), email: z.email(), image: z.string().nullable() });

export function PatientProfile() {
  const [profile, setProfile] = useState<PatientProfileData | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    async function loadProfile() {
      try {
        const response = await fetch(`${backendUrl}/api/patients/me`, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 401 ? "Your session expired. Log in again." : "Could not load your profile.");
        const parsed = patientProfileResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Your profile returned an unexpected response.");
        if (active) {
          setProfile(parsed.data); setName(parsed.data.name); setImage(parsed.data.image ?? "");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load your profile.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadProfile();
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSuccess(""); setFieldErrors({});
    const imageChanged = image !== (profile?.image ?? "");
    const parsed = patientProfileFormSchema.safeParse({ name, ...(imageChanged ? { image } : {}) });
    if (!parsed.success) {
      setFieldErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])));
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`${backendUrl}/api/patients/me`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: parsed.data.name, ...(imageChanged ? { image: parsed.data.image || null } : {}) }),
      });
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("Only patient accounts can edit this profile.");
      if (!response.ok) throw new Error(response.status === 400 ? "Check your name and image URL." : "Could not save your profile. Please try again.");
      const updated = patientProfileResponseSchema.parse(await response.json());
      setProfile(updated); setName(updated.name); setImage(updated.image ?? ""); setEditing(false);
      setSuccess("Profile updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    if (!profile) return;
    setName(profile.name); setImage(profile.image ?? ""); setEditing(false); setError(""); setFieldErrors({});
  }

  return <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
    <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">Patient account</p>
    <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Your profile</h1>
    <p className="mt-3 text-slate-600">View and update your contact profile details.</p>
    <Card className="mt-8">
      <CardHeader><CardTitle>Personal details</CardTitle><CardDescription>Your email is read-only. Name and profile image can be updated.</CardDescription></CardHeader>
      <CardContent>
        {loading && <p role="status" className="text-sm text-slate-600">Loading your profile…</p>}
        {!loading && !profile && <p role="alert" className="text-sm text-red-700">{error || "Profile unavailable."}</p>}
        {profile && <form onSubmit={save} noValidate className="space-y-5">
          <div className="space-y-1.5"><label htmlFor="profile-email" className="text-sm font-medium text-slate-800">Email</label><Input id="profile-email" value={profile.email} readOnly disabled /></div>
          <ProfileField id="profile-name" label="Full name" error={fieldErrors.name}><Input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={100} readOnly={!editing} disabled={!editing} aria-invalid={Boolean(fieldErrors.name)} /></ProfileField>
          <ProfileField id="profile-image" label="Profile image URL (optional)" error={fieldErrors.image}><Input id="profile-image" type="url" value={image} onChange={(event) => setImage(event.target.value)} placeholder="https://example.com/photo.jpg" readOnly={!editing} disabled={!editing} aria-invalid={Boolean(fieldErrors.image)} /></ProfileField>
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          {success && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{success}</p>}
          <div className="flex flex-wrap gap-3">{editing ? <><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button><Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>Cancel</Button></> : <Button type="button" onClick={() => { setEditing(true); setSuccess(""); }}>Edit profile</Button>}</div>
        </form>}
      </CardContent>
    </Card>
  </main>;
}

function ProfileField({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium text-slate-800">{label}</label>{children}{error && <p className="text-sm text-red-700">{error}</p>}</div>;
}
