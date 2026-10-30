"use client";

import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ShieldCheck, Edit3, Save, X } from "lucide-react";
import { backendUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const doctorProfileSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  name: z.string(),
  email: z.email(),
  specialty: z.string(),
  licenseRegion: z.string(),
  licenseNumber: z.string(),
  bio: z.string().nullable(),
  phone: z.string().nullable().optional(),
  qualifications: z.string().nullable().optional(),
  yearsOfExperience: z.number().int().nullable().optional(),
  consultationFeeInr: z.number().int().nullable().optional(),
  clinicName: z.string().nullable().optional(),
  clinicAddress: z.string().nullable().optional(),
  profilePhotoUrl: z.string().nullable().optional(),
  isVerified: z.boolean().optional(),
});

type DoctorProfile = z.infer<typeof doctorProfileSchema>;

export function DoctorProfileView() {
  const [profile, setProfile] = useState<DoctorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadProfile() {
      try {
        const response = await fetch(`${backendUrl}/api/doctors/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(
            response.status === 401
              ? "Your session expired. Log in again."
              : response.status === 403
                ? "Your doctor profile is not yet approved."
                : "Could not load your profile."
          );
        }
        const parsed = doctorProfileSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Profile returned an unexpected response.");
        if (active) setProfile(parsed.data);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load your profile.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadProfile();
    return () => { active = false; };
  }, []);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);

    const form = new FormData(event.currentTarget);
    const payload = {
      bio: form.get("bio") ? String(form.get("bio")).trim() : null,
      phone: form.get("phone") ? String(form.get("phone")).trim() : null,
      qualifications: form.get("qualifications") ? String(form.get("qualifications")).trim() : null,
      yearsOfExperience: form.get("yearsOfExperience") ? Number(form.get("yearsOfExperience")) : null,
      consultationFeeInr: form.get("consultationFeeInr") ? Number(form.get("consultationFeeInr")) : null,
      clinicName: form.get("clinicName") ? String(form.get("clinicName")).trim() : null,
      clinicAddress: form.get("clinicAddress") ? String(form.get("clinicAddress")).trim() : null,
      profilePhotoUrl: form.get("profilePhotoUrl") ? String(form.get("profilePhotoUrl")).trim() : null,
    };

    try {
      const response = await fetch(`${backendUrl}/api/doctors/me`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        throw new Error(errJson?.message ?? "Failed to update profile.");
      }

      const updated = await response.json();
      setProfile(updated);
      setSuccess("Your practice profile was updated successfully.");
      setIsEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update profile.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p role="status" className="text-sm text-slate-600">Loading profile…</p>;
  if (error && !profile) return <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!profile) return null;

  return (
    <div className="space-y-6">
      {success && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm font-medium text-emerald-800">
          {success}
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm font-medium text-red-800">
          {error}
        </div>
      )}

      {/* Header card with Verified Badge */}
      <Card className="border-slate-200">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              {profile.profilePhotoUrl ? (
                <img
                  src={profile.profilePhotoUrl}
                  alt={`${profile.name} profile photo`}
                  className="h-20 w-20 rounded-full object-cover border-2 border-slate-200 shrink-0"
                />
              ) : (
                <div className="h-20 w-20 rounded-full bg-teal-100 flex items-center justify-center shrink-0 border-2 border-teal-200">
                  <span className="text-teal-700 font-bold text-2xl">{profile.name.charAt(0)}</span>
                </div>
              )}
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-2xl font-bold">{profile.name}</CardTitle>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800 border border-emerald-200">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                    Verified Doctor
                  </span>
                </div>
                <CardDescription className="text-base text-slate-700 font-medium">
                  {profile.specialty}
                </CardDescription>
                {profile.qualifications && (
                  <p className="text-sm text-slate-500">{profile.qualifications}</p>
                )}
              </div>
            </div>

            <Button
              type="button"
              variant={isEditing ? "ghost" : "outline"}
              onClick={() => setIsEditing((prev) => !prev)}
              className="text-xs"
            >
              {isEditing ? (
                <>
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Cancel
                </>
              ) : (
                <>
                  <Edit3 className="mr-1.5 h-3.5 w-3.5" />
                  Edit Practice Profile
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        {!isEditing && profile.bio && (
          <CardContent>
            <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">
              {profile.bio}
            </p>
          </CardContent>
        )}
      </Card>

      {/* Editing Form */}
      {isEditing ? (
        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle className="text-lg">Edit Practice Details</CardTitle>
            <CardDescription>
              Update your public practice information, bio, consultation fee, and clinic details.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label htmlFor="qualifications" className="text-xs font-medium text-slate-700">
                    Degrees & Qualifications
                  </label>
                  <Input
                    id="qualifications"
                    name="qualifications"
                    defaultValue={profile.qualifications ?? ""}
                    placeholder="e.g. MBBS, MD (Cardiology)"
                    disabled={saving}
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="yearsOfExperience" className="text-xs font-medium text-slate-700">
                    Years of Experience
                  </label>
                  <Input
                    id="yearsOfExperience"
                    name="yearsOfExperience"
                    type="number"
                    min={0}
                    max={70}
                    defaultValue={profile.yearsOfExperience ?? 0}
                    disabled={saving}
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="consultationFeeInr" className="text-xs font-medium text-slate-700">
                    Consultation Fee (₹ INR)
                  </label>
                  <Input
                    id="consultationFeeInr"
                    name="consultationFeeInr"
                    type="number"
                    min={0}
                    defaultValue={profile.consultationFeeInr ?? 500}
                    disabled={saving}
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="phone" className="text-xs font-medium text-slate-700">
                    Contact Phone
                  </label>
                  <Input
                    id="phone"
                    name="phone"
                    type="tel"
                    defaultValue={profile.phone ?? ""}
                    placeholder="+91 98765 43210"
                    disabled={saving}
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="clinicName" className="text-xs font-medium text-slate-700">
                    Clinic / Hospital Name
                  </label>
                  <Input
                    id="clinicName"
                    name="clinicName"
                    defaultValue={profile.clinicName ?? ""}
                    placeholder="e.g. City Health Clinic"
                    disabled={saving}
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="profilePhotoUrl" className="text-xs font-medium text-slate-700">
                    Profile Photo URL
                  </label>
                  <Input
                    id="profilePhotoUrl"
                    name="profilePhotoUrl"
                    type="url"
                    defaultValue={profile.profilePhotoUrl ?? ""}
                    placeholder="https://example.com/photo.jpg"
                    disabled={saving}
                  />
                </div>

                <div className="space-y-1 sm:col-span-2">
                  <label htmlFor="clinicAddress" className="text-xs font-medium text-slate-700">
                    Clinic Address
                  </label>
                  <Input
                    id="clinicAddress"
                    name="clinicAddress"
                    defaultValue={profile.clinicAddress ?? ""}
                    placeholder="Clinic street address, city, state"
                    disabled={saving}
                  />
                </div>

                <div className="space-y-1 sm:col-span-2">
                  <label htmlFor="bio" className="text-xs font-medium text-slate-700">
                    Professional Biography
                  </label>
                  <Input
                    id="bio"
                    name="bio"
                    defaultValue={profile.bio ?? ""}
                    placeholder="Summary of clinical background, areas of expertise, and approach to care"
                    disabled={saving}
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsEditing(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={saving} className="bg-teal-700 hover:bg-teal-800 text-white">
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Practice details */}
          <Card className="border-slate-200">
            <CardHeader>
              <CardTitle className="text-lg">Practice details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {profile.consultationFeeInr != null && (
                  <ProfileDetail
                    label="Consultation fee"
                    value={`₹${profile.consultationFeeInr.toLocaleString("en-IN")}`}
                    highlight
                  />
                )}
                {profile.yearsOfExperience != null && (
                  <ProfileDetail
                    label="Years of experience"
                    value={`${profile.yearsOfExperience} year${profile.yearsOfExperience !== 1 ? "s" : ""}`}
                  />
                )}
                {profile.clinicName && <ProfileDetail label="Clinic / hospital" value={profile.clinicName} />}
                {profile.phone && <ProfileDetail label="Contact phone" value={profile.phone} />}
                {profile.clinicAddress && (
                  <div className="sm:col-span-2">
                    <ProfileDetail label="Clinic address" value={profile.clinicAddress} />
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          {/* License details (Verified — read-only) */}
          <Card className="border-slate-200">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Verified Medical License</CardTitle>
                  <CardDescription>
                    Official licensing records verified by Medrella administration.
                  </CardDescription>
                </div>
                <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800 border border-emerald-200">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                  Verified & Locked
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                <ProfileDetail label="Licensing Council / State" value={profile.licenseRegion} />
                <ProfileDetail label="Registration / License Number" value={profile.licenseNumber} />
                <ProfileDetail label="Account Email" value={profile.email} />
                <ProfileDetail label="Medical Specialty" value={profile.specialty} />
              </dl>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ProfileDetail({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-1 break-words text-sm ${highlight ? "text-teal-800 font-semibold text-base" : "text-slate-900"}`}>
        {value}
      </dd>
    </div>
  );
}
