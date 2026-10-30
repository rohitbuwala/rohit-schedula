"use client";

import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Droplet,
  HeartPulse,
  Mail,
  MapPin,
  Pencil,
  Phone,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import {
  bloodGroups,
  genders,
  patientProfileFormSchema,
} from "@/lib/patient-profile-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const patientProfileResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  image: z.string().nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  bloodGroup: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  allergies: z.string().nullable().optional(),
});

type PatientProfileData = z.infer<typeof patientProfileResponseSchema>;

export function PatientProfile() {
  const [profile, setProfile] = useState<PatientProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Form state
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState("");
  const [phone, setPhone] = useState("");
  const [bloodGroup, setBloodGroup] = useState("");
  const [address, setAddress] = useState("");
  const [allergies, setAllergies] = useState("");

  function populateForm(data: PatientProfileData) {
    setName(data.name || "");
    setImage(data.image || "");
    setDateOfBirth(data.dateOfBirth || "");
    setGender(data.gender || "");
    setPhone(data.phone || "");
    setBloodGroup(data.bloodGroup || "");
    setAddress(data.address || "");
    setAllergies(data.allergies || "");
  }

  useEffect(() => {
    let active = true;
    async function loadProfile() {
      try {
        const response = await fetch(`${backendUrl}/api/patients/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(
            response.status === 401
              ? "Your session expired. Log in again."
              : "Could not load your patient profile."
          );
        }
        const parsed = patientProfileResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error("Patient profile returned an unexpected format.");
        }
        if (active) {
          setProfile(parsed.data);
          populateForm(parsed.data);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load your profile.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadProfile();
    return () => {
      active = false;
    };
  }, []);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setFieldErrors({});

    const formData = {
      name,
      image: image || null,
      dateOfBirth: dateOfBirth || null,
      gender: gender || null,
      phone: phone || null,
      bloodGroup: bloodGroup || null,
      address: address || null,
      allergies: allergies || null,
    };

    const parsed = patientProfileFormSchema.safeParse(formData);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const fieldName = String(issue.path[0]);
        if (!errors[fieldName]) errors[fieldName] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`${backendUrl}/api/patients/me`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("Only patient accounts can edit this profile.");
      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.message || "Could not save your profile. Please check the values provided.");
      }

      const updated = patientProfileResponseSchema.parse(await response.json());
      setProfile(updated);
      populateForm(updated);
      setEditing(false);
      setSuccess("Your patient profile has been updated successfully.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save profile.");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (profile) populateForm(profile);
    setEditing(false);
    setError("");
    setFieldErrors({});
  }

  function formatDisplayDate(dateStr: string | null | undefined): string {
    if (!dateStr) return "Not provided";
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    const formatted = d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Kolkata",
    });
    // Calculate approximate age
    const diff = Date.now() - d.getTime();
    const age = Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
    return age >= 0 ? `${formatted} (${age} years old)` : formatted;
  }

  function formatGenderLabel(value: string | null | undefined): string {
    if (!value) return "Not specified";
    const map: Record<string, string> = {
      male: "Male",
      female: "Female",
      other: "Other",
      prefer_not_to_say: "Prefer not to say",
    };
    return map[value] || value;
  }

  return (
    <div className="space-y-8">
      {/* Profile Header Banner */}
      <div className="rounded-3xl border border-teal-100 bg-gradient-to-br from-teal-950 via-teal-900 to-slate-900 p-6 sm:p-8 text-white shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
          <div className="flex items-center gap-5">
            {profile?.image ? (
              <img
                src={profile.image}
                alt={`${profile.name}'s photo`}
                className="h-20 w-20 rounded-2xl object-cover border-2 border-white/20 shadow-md shrink-0"
              />
            ) : (
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-teal-800 text-teal-100 text-2xl font-bold border-2 border-white/20 shadow-md">
                {profile?.name ? profile.name.charAt(0).toUpperCase() : <User className="h-8 w-8" />}
              </div>
            )}
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-teal-800/70 px-3 py-0.5 text-xs font-semibold text-teal-200 backdrop-blur">
                <ShieldCheck className="h-3.5 w-3.5" />
                Verified Patient Account
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                {profile?.name || "Patient Profile"}
              </h1>
              <p className="text-xs sm:text-sm text-teal-200/90 flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" />
                {profile?.email}
              </p>
            </div>
          </div>

          {!loading && profile && !editing && (
            <Button
              type="button"
              onClick={() => {
                setEditing(true);
                setSuccess("");
                setError("");
              }}
              className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-xs h-9 shadow-md transition"
            >
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Edit Profile
            </Button>
          )}
        </div>
      </div>

      {/* Feedback Alerts */}
      {error && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-xs font-medium text-red-700 border border-red-200 flex items-start gap-2.5">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-600 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div role="status" className="rounded-xl bg-emerald-50 p-4 text-xs font-medium text-emerald-800 border border-emerald-200 flex items-start gap-2.5">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      {loading && (
        <Card className="border-slate-200 bg-white p-12 text-center text-xs text-slate-500">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-700 border-t-transparent mx-auto mb-3" />
          Loading your patient profile details…
        </Card>
      )}

      {/* View Mode: Clean, Structured Profile Cards */}
      {!loading && profile && !editing && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Personal & Demographics */}
          <Card className="border-slate-200 shadow-xs">
            <CardHeader className="pb-3 border-b border-slate-100">
              <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                <User className="h-4 w-4 text-teal-700" />
                Personal Details
              </CardTitle>
              <CardDescription className="text-xs">
                Essential identity and demographic information.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <dl className="grid gap-4 text-xs">
                <DetailRow label="Full Name" value={profile.name} />
                <DetailRow
                  label="Date of Birth"
                  value={formatDisplayDate(profile.dateOfBirth)}
                  icon={<Calendar className="h-3.5 w-3.5 text-slate-400" />}
                />
                <DetailRow label="Gender" value={formatGenderLabel(profile.gender)} />
                <DetailRow
                  label="Profile Photo URL"
                  value={profile.image || "Not set (default initials avatar)"}
                />
              </dl>
            </CardContent>
          </Card>

          {/* Contact Information */}
          <Card className="border-slate-200 shadow-xs">
            <CardHeader className="pb-3 border-b border-slate-100">
              <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Phone className="h-4 w-4 text-teal-700" />
                Contact Information
              </CardTitle>
              <CardDescription className="text-xs">
                Ways clinics and verified practitioners can reach you.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <dl className="grid gap-4 text-xs">
                <DetailRow
                  label="Email Address"
                  value={profile.email}
                  subtext="Authentication primary email (read-only)"
                  icon={<Mail className="h-3.5 w-3.5 text-slate-400" />}
                />
                <DetailRow
                  label="Contact Phone"
                  value={profile.phone || "Not provided"}
                  icon={<Phone className="h-3.5 w-3.5 text-slate-400" />}
                />
                <DetailRow
                  label="Residential Address"
                  value={profile.address || "No address provided."}
                  icon={<MapPin className="h-3.5 w-3.5 text-slate-400" />}
                />
              </dl>
            </CardContent>
          </Card>

          {/* Clinical Quick Reference */}
          <Card className="border-slate-200 shadow-xs md:col-span-2">
            <CardHeader className="pb-3 border-b border-slate-100">
              <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                <HeartPulse className="h-4 w-4 text-rose-600" />
                Essential Clinical Quick Reference
              </CardTitle>
              <CardDescription className="text-xs">
                Critical health details visible to attending physicians during scheduled appointments.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid gap-6 sm:grid-cols-2 text-xs">
                <div>
                  <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <Droplet className="h-3.5 w-3.5 text-red-500" />
                    Blood Group
                  </dt>
                  <dd className="mt-1">
                    {profile.bloodGroup ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-50 text-rose-800 border border-rose-200">
                        {profile.bloodGroup}
                      </span>
                    ) : (
                      <span className="text-slate-500">Not recorded</span>
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                    Known Allergies
                  </dt>
                  <dd className="mt-1">
                    {profile.allergies ? (
                      <div className="rounded-xl bg-amber-50/80 p-3 text-xs text-amber-900 border border-amber-200 font-medium">
                        {profile.allergies}
                      </div>
                    ) : (
                      <span className="text-slate-500">No known allergies reported</span>
                    )}
                  </dd>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Edit Mode: Form */}
      {!loading && profile && editing && (
        <Card className="border-slate-200 shadow-sm bg-white">
          <CardHeader className="border-b border-slate-100 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg font-bold text-slate-900">
                  Edit Patient Profile
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  Update your essential personal, contact, and clinical safety details.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                className="h-8 w-8 p-0 text-slate-500 hover:text-slate-900"
                aria-label="Close edit mode"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleSave} noValidate className="space-y-6">
              <div className="grid gap-5 sm:grid-cols-2">
                {/* Email (Read only) */}
                <div className="space-y-1.5">
                  <label htmlFor="patient-email" className="text-xs font-semibold text-slate-700">
                    Account Email
                  </label>
                  <Input
                    id="patient-email"
                    value={profile.email}
                    disabled
                    readOnly
                    className="bg-slate-50 text-slate-500 text-xs h-9 cursor-not-allowed"
                  />
                  <p className="text-[11px] text-slate-400">Primary authentication email cannot be modified here.</p>
                </div>

                {/* Full Name */}
                <FormField
                  id="patient-name"
                  label="Full Name *"
                  error={fieldErrors.name}
                  hint="Your official legal name."
                >
                  <Input
                    id="patient-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    maxLength={100}
                    placeholder="e.g. Alex Morgan"
                    className="text-xs h-9"
                    aria-invalid={Boolean(fieldErrors.name)}
                  />
                </FormField>

                {/* Date of Birth */}
                <FormField
                  id="patient-dob"
                  label="Date of Birth"
                  error={fieldErrors.dateOfBirth}
                  hint="Used by physicians to adjust care & dosage."
                >
                  <Input
                    id="patient-dob"
                    type="date"
                    value={dateOfBirth}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                    max={new Date().toISOString().slice(0, 10)}
                    className="text-xs h-9"
                    aria-invalid={Boolean(fieldErrors.dateOfBirth)}
                  />
                </FormField>

                {/* Gender */}
                <FormField
                  id="patient-gender"
                  label="Gender"
                  error={fieldErrors.gender}
                >
                  <select
                    id="patient-gender"
                    value={gender}
                    onChange={(e) => setGender(e.target.value)}
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600 h-9"
                    aria-invalid={Boolean(fieldErrors.gender)}
                  >
                    <option value="">Select Gender (Optional)</option>
                    {genders.map((g) => (
                      <option key={g} value={g}>
                        {formatGenderLabel(g)}
                      </option>
                    ))}
                  </select>
                </FormField>

                {/* Phone */}
                <FormField
                  id="patient-phone"
                  label="Phone Number"
                  error={fieldErrors.phone}
                  hint="7–15 digits for appointment updates & confirmations."
                >
                  <Input
                    id="patient-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="e.g. +91 98765 43210"
                    className="text-xs h-9"
                    aria-invalid={Boolean(fieldErrors.phone)}
                  />
                </FormField>

                {/* Blood Group */}
                <FormField
                  id="patient-blood"
                  label="Blood Group (Optional)"
                  error={fieldErrors.bloodGroup}
                  hint="Crucial for emergencies and clinic records."
                >
                  <select
                    id="patient-blood"
                    value={bloodGroup}
                    onChange={(e) => setBloodGroup(e.target.value)}
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600 h-9"
                    aria-invalid={Boolean(fieldErrors.bloodGroup)}
                  >
                    <option value="">Select Blood Group</option>
                    {bloodGroups.map((bg) => (
                      <option key={bg} value={bg}>
                        {bg}
                      </option>
                    ))}
                  </select>
                </FormField>

                {/* Profile Photo URL */}
                <div className="sm:col-span-2">
                  <FormField
                    id="patient-image"
                    label="Profile Photo URL (Optional)"
                    error={fieldErrors.image}
                    hint="Secure HTTPS link to your photo."
                  >
                    <Input
                      id="patient-image"
                      type="url"
                      value={image}
                      onChange={(e) => setImage(e.target.value)}
                      placeholder="https://example.com/my-photo.jpg"
                      className="text-xs h-9"
                      aria-invalid={Boolean(fieldErrors.image)}
                    />
                  </FormField>
                </div>

                {/* Address */}
                <div className="sm:col-span-2">
                  <FormField
                    id="patient-address"
                    label="Residential Address (Optional)"
                    error={fieldErrors.address}
                    hint="For postal correspondence or prescription deliveries."
                  >
                    <Input
                      id="patient-address"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      maxLength={500}
                      placeholder="Street, City, State / Region, Postal Code"
                      className="text-xs h-9"
                      aria-invalid={Boolean(fieldErrors.address)}
                    />
                  </FormField>
                </div>

                {/* Allergies */}
                <div className="sm:col-span-2">
                  <FormField
                    id="patient-allergies"
                    label="Known Drug or Food Allergies (Optional)"
                    error={fieldErrors.allergies}
                    hint="e.g. Penicillin, Sulfa drugs, Peanuts, Latex. Helps prevent adverse reactions."
                  >
                    <Input
                      id="patient-allergies"
                      value={allergies}
                      onChange={(e) => setAllergies(e.target.value)}
                      maxLength={500}
                      placeholder="List any known allergies or leave empty if none"
                      className="text-xs h-9"
                      aria-invalid={Boolean(fieldErrors.allergies)}
                    />
                  </FormField>
                </div>
              </div>

              {/* Form buttons */}
              <div className="flex items-center gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="submit"
                  disabled={saving}
                  className="bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs h-9"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                  {saving ? "Saving…" : "Save Changes"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCancel}
                  disabled={saving}
                  className="text-xs h-9"
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  subtext,
  icon,
}: {
  label: string;
  value: string;
  subtext?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 font-medium text-slate-900 break-words">{value}</dd>
      {subtext && <p className="text-[10px] text-slate-400 mt-0.5">{subtext}</p>}
    </div>
  );
}

function FormField({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-xs font-semibold text-slate-700">
          {label}
        </label>
      </div>
      {children}
      {hint && !error && <p className="text-[11px] text-slate-400">{hint}</p>}
      {error && <p className="text-[11px] font-medium text-red-600">{error}</p>}
    </div>
  );
}
