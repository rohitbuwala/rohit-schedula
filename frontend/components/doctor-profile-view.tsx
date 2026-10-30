"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { backendUrl } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
});

type DoctorProfile = z.infer<typeof doctorProfileSchema>;

export function DoctorProfileView() {
  const [profile, setProfile] = useState<DoctorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  if (loading) return <p role="status" className="text-sm text-slate-600">Loading profile…</p>;
  if (error) return <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!profile) return null;

  return (
    <div className="space-y-6">
      {/* Header card */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-5">
            {profile.profilePhotoUrl ? (
              <img
                src={profile.profilePhotoUrl}
                alt={`${profile.name} profile photo`}
                className="h-20 w-20 rounded-full object-cover border-2 border-slate-200 flex-shrink-0"
              />
            ) : (
              <div className="h-20 w-20 rounded-full bg-teal-100 flex items-center justify-center flex-shrink-0 border-2 border-teal-200">
                <span className="text-teal-700 font-bold text-2xl">{profile.name.charAt(0)}</span>
              </div>
            )}
            <div>
              <CardTitle className="text-2xl">{profile.name}</CardTitle>
              <CardDescription className="text-base mt-1">{profile.specialty}</CardDescription>
              {profile.qualifications && (
                <p className="mt-1 text-sm text-slate-500">{profile.qualifications}</p>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {profile.bio && <p className="text-sm text-slate-700 leading-6">{profile.bio}</p>}
        </CardContent>
      </Card>

      {/* Practice details */}
      <Card>
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

      {/* License details (private — own view only) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">License details</CardTitle>
          <CardDescription>Visible to you only — not shown publicly.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <ProfileDetail label="License region" value={profile.licenseRegion} />
            <ProfileDetail label="License number" value={profile.licenseNumber} />
            <ProfileDetail label="Email" value={profile.email} />
          </dl>
        </CardContent>
      </Card>
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
