"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Clock,
  AlertCircle,
  CheckCircle2,
  RotateCw,
  Building2,
  GraduationCap,
  ShieldCheck,
  Stethoscope,
  IndianRupee,
  Calendar,
  FileEdit,
  Phone,
  Save,
  Info,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import { doctorApplicationFormSchema } from "@/lib/doctor-application-validation";
import type { DoctorApplicationResponse } from "@/lib/doctor-application-response";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface DoctorPendingDashboardProps {
  applicant: DoctorApplicationResponse;
  userName: string;
}

export function DoctorPendingDashboard({ applicant: initialApplicant, userName }: DoctorPendingDashboardProps) {
  const router = useRouter();
  const [applicant, setApplicant] = useState<DoctorApplicationResponse>(initialApplicant);
  const [isEditing, setIsEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Profile completeness calculation
  const completeness = useMemo(() => {
    let score = 0;
    const checks = [
      Boolean(applicant.specialty),
      Boolean(applicant.licenseRegion),
      Boolean(applicant.licenseNumber),
      Boolean(applicant.qualifications),
      applicant.yearsOfExperience != null && applicant.yearsOfExperience >= 0,
      Boolean(applicant.phone),
      applicant.consultationFeeInr != null && applicant.consultationFeeInr > 0,
      Boolean(applicant.clinicName),
      Boolean(applicant.clinicAddress),
      Boolean(applicant.bio),
    ];
    for (const c of checks) {
      if (c) score += 10;
    }
    return score;
  }, [applicant]);

  const isRejected = applicant.status === "rejected";

  async function handleRefresh() {
    setRefreshing(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(`${backendUrl}/api/doctor-applications/me`, {
        credentials: "include",
        cache: "no-store",
      });
      if (response.ok) {
        const text = await response.text();
        if (text) {
          const updated = JSON.parse(text);
          if (updated && updated.status === "approved") {
            // Elevated to approved doctor! Reload page to switch to clinical workspace
            router.refresh();
            return;
          }
          if (updated) setApplicant(updated);
        }
      }
    } catch {
      setError("Could not refresh status. Please try again.");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleResubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const parsed = doctorApplicationFormSchema.safeParse({
      specialty: form.get("specialty"),
      licenseRegion: form.get("licenseRegion"),
      licenseNumber: form.get("licenseNumber"),
      bio: form.get("bio"),
      phone: form.get("phone"),
      qualifications: form.get("qualifications"),
      yearsOfExperience: form.get("yearsOfExperience"),
      consultationFeeInr: form.get("consultationFeeInr"),
      clinicName: form.get("clinicName"),
      clinicAddress: form.get("clinicAddress"),
      profilePhotoUrl: form.get("profilePhotoUrl"),
    });

    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]))
      );
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${backendUrl}/api/doctor-applications`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (response.status === 401) {
        throw new Error("Your session expired. Please log in again.");
      }
      if (response.status === 409) {
        throw new Error("Your profile is already approved. Refreshing workspace…");
      }
      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        throw new Error(errJson?.message ?? "Failed to update application. Please try again.");
      }

      const updated = await response.json();
      setApplicant(updated);
      setSuccess("Your professional profile credentials were submitted for review.");
      setIsEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update application.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-8">
      {/* Top Banner with Status Badge */}
      <div
        className={`rounded-3xl border-2 p-6 sm:p-8 shadow-sm ${
          isRejected
            ? "border-red-300 bg-gradient-to-br from-red-50 via-white to-red-50/30"
            : "border-amber-300 bg-gradient-to-br from-amber-50 via-white to-amber-50/40"
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${
                  isRejected
                    ? "bg-red-100 text-red-800 border border-red-200"
                    : "bg-amber-100 text-amber-800 border border-amber-200"
                }`}
              >
                {isRejected ? (
                  <>
                    <AlertCircle className="h-4 w-4 text-red-700" />
                    Verification Rejected
                  </>
                ) : (
                  <>
                    <Clock className="h-4 w-4 text-amber-700 animate-pulse" />
                    Pending Verification
                  </>
                )}
              </span>

              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-mono text-slate-600 border border-slate-200">
                Application #{applicant.id.slice(0, 8)}
              </span>
            </div>

            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
                Dr. {userName}
              </h1>
              <p className="mt-1 text-sm text-slate-600 max-w-2xl leading-relaxed">
                {isRejected
                  ? "Your medical credentials could not be verified with the medical council based on the details submitted. Please review the feedback below, correct your information, and resubmit for verification."
                  : "Thank you for registering on Medrella. All doctor profiles undergo administrative credential verification to check council registration before practice activation."}
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleRefresh}
              disabled={refreshing}
              className="bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
            >
              <RotateCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh Status
            </Button>

            {!isEditing && (
              <Button
                type="button"
                onClick={() => setIsEditing(true)}
                className="bg-teal-700 hover:bg-teal-800 text-white"
              >
                <FileEdit className="mr-2 h-4 w-4" />
                {isRejected ? "Correct & Resubmit Details" : "Edit Profile"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Rejection Reason from Admin */}
      {isRejected && applicant.rejectionReason && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-5 text-red-950 space-y-2 shadow-xs">
          <div className="flex items-center gap-2 font-bold text-sm text-red-900">
            <AlertCircle className="h-5 w-5 text-red-700 shrink-0" />
            Administrative Verification Feedback & Rejection Reason
          </div>
          <p className="text-sm font-semibold text-red-950 pl-7 leading-relaxed bg-white/90 p-3.5 rounded-xl border border-red-200">
            &ldquo;{applicant.rejectionReason}&rdquo;
          </p>
          <p className="text-xs text-red-800 pl-7">
            Your account is preserved. Please update your registration number, council, or qualifications below and click <strong>Save & Resubmit Application</strong>.
          </p>
        </div>
      )}

      {/* Safety Notice Banner */}
      <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 text-xs text-blue-900 flex items-start gap-3">
        <Info className="h-5 w-5 text-blue-700 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-sm text-blue-950">Patient Safety & Booking Protection</p>
          <p className="mt-0.5 text-blue-800 leading-relaxed">
            While your verification is pending or rejected, your profile remains unverified. You will not receive patient bookings
            or appear in public search until our clinical administration team verifies your credentials.
          </p>
        </div>
      </div>

      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Grid: Verification Stepper & Profile Completeness */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Verification Stepper (2 cols) */}
        <Card className="md:col-span-2 border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-slate-900">Verification Steps</CardTitle>
            <CardDescription className="text-xs">
              Application submitted on{" "}
              {new Date(applicant.submittedAt).toLocaleDateString("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              IST
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 space-y-1.5">
                <div className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white text-xs font-bold">
                  ✓
                </div>
                <p className="text-xs font-bold text-emerald-950">1. Submitted</p>
                <p className="text-[11px] text-emerald-700">Profile & License</p>
              </div>

              <div
                className={`rounded-xl border p-3 space-y-1.5 ${
                  isRejected
                    ? "border-red-200 bg-red-50/50"
                    : "border-amber-300 bg-amber-50/60"
                }`}
              >
                <div
                  className={`mx-auto flex h-7 w-7 items-center justify-center rounded-full text-white text-xs font-bold ${
                    isRejected ? "bg-red-600" : "bg-amber-600 animate-pulse"
                  }`}
                >
                  {isRejected ? "!" : "2"}
                </div>
                <p className={`text-xs font-bold ${isRejected ? "text-red-950" : "text-amber-950"}`}>
                  2. Council Check
                </p>
                <p className={`text-[11px] ${isRejected ? "text-red-700 font-semibold" : "text-amber-700 font-medium"}`}>
                  {isRejected ? "Rejected — Resubmit" : "Under Review"}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1.5 opacity-60">
                <div className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-slate-300 text-slate-700 text-xs font-bold">
                  3
                </div>
                <p className="text-xs font-bold text-slate-700">3. Practice Live</p>
                <p className="text-[11px] text-slate-500">Public Bookings</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Profile Completeness Card (1 col) */}
        <Card className="border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-slate-900">Profile Completeness</CardTitle>
            <CardDescription className="text-xs">Required and optional details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold text-teal-700">{completeness}%</span>
              <span className="text-xs text-slate-500">
                {completeness === 100 ? "All fields complete" : "Add details to optimize"}
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all duration-500 rounded-full"
                style={{ width: `${completeness}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500 leading-tight">
              Completing bio and clinic details helps patients find and book with you once your license verification is complete.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Form or Details View */}
      {isEditing ? (
        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-xl font-bold text-slate-900">Edit Professional Credentials</CardTitle>
                <CardDescription>Update your license or practice information and submit for review.</CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsEditing(false)}
                className="text-slate-600 hover:text-slate-900"
              >
                Cancel
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleResubmit} noValidate className="space-y-6">
              {/* Section: Medical License (Required) */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                  <GraduationCap className="h-4 w-4 text-teal-700" />
                  <h3 className="text-sm font-semibold text-slate-900">Medical Licensing (Required)</h3>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field id="specialty" label="Medical Specialty *" error={fieldErrors.specialty}>
                    <Input
                      id="specialty"
                      name="specialty"
                      defaultValue={applicant.specialty}
                      placeholder="e.g. Cardiology"
                      required
                      maxLength={100}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="qualifications" label="Degrees & Qualifications *" error={fieldErrors.qualifications}>
                    <Input
                      id="qualifications"
                      name="qualifications"
                      defaultValue={applicant.qualifications ?? ""}
                      placeholder="e.g. MBBS, MD (Cardiology)"
                      required
                      maxLength={500}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="licenseRegion" label="Licensing Council / State *" error={fieldErrors.licenseRegion}>
                    <Input
                      id="licenseRegion"
                      name="licenseRegion"
                      defaultValue={applicant.licenseRegion}
                      placeholder="National Medical Commission"
                      required
                      maxLength={80}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="licenseNumber" label="Registration / License Number *" error={fieldErrors.licenseNumber}>
                    <Input
                      id="licenseNumber"
                      name="licenseNumber"
                      defaultValue={applicant.licenseNumber}
                      placeholder="e.g. MCI-2018-98765"
                      required
                      maxLength={80}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="yearsOfExperience" label="Years of Experience *" error={fieldErrors.yearsOfExperience}>
                    <Input
                      id="yearsOfExperience"
                      name="yearsOfExperience"
                      type="number"
                      min={0}
                      max={70}
                      defaultValue={applicant.yearsOfExperience ?? 5}
                      required
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="phone" label="Contact Phone *" error={fieldErrors.phone}>
                    <Input
                      id="phone"
                      name="phone"
                      type="tel"
                      defaultValue={applicant.phone ?? ""}
                      placeholder="+91 98765 43210"
                      required
                      disabled={submitting}
                    />
                  </Field>
                </div>
              </div>

              {/* Section: Practice Details (Optional) */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                  <Building2 className="h-4 w-4 text-teal-700" />
                  <h3 className="text-sm font-semibold text-slate-900">Practice Information (Optional)</h3>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field id="consultationFeeInr" label="Consultation Fee (₹ INR)" error={fieldErrors.consultationFeeInr}>
                    <Input
                      id="consultationFeeInr"
                      name="consultationFeeInr"
                      type="number"
                      min={0}
                      defaultValue={applicant.consultationFeeInr ?? 500}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="clinicName" label="Clinic / Hospital Name" error={fieldErrors.clinicName}>
                    <Input
                      id="clinicName"
                      name="clinicName"
                      defaultValue={applicant.clinicName ?? ""}
                      placeholder="e.g. City Care Hospital"
                      maxLength={200}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="clinicAddress" label="Clinic Address" error={fieldErrors.clinicAddress} className="sm:col-span-2">
                    <Input
                      id="clinicAddress"
                      name="clinicAddress"
                      defaultValue={applicant.clinicAddress ?? ""}
                      placeholder="Street, City, State"
                      maxLength={500}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="bio" label="Professional Biography" error={fieldErrors.bio} className="sm:col-span-2">
                    <Input
                      id="bio"
                      name="bio"
                      defaultValue={applicant.bio ?? ""}
                      placeholder="Brief summary of clinical background and care philosophy"
                      maxLength={1000}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="profilePhotoUrl" label="Profile Photo URL (HTTPS)" error={fieldErrors.profilePhotoUrl} className="sm:col-span-2">
                    <Input
                      id="profilePhotoUrl"
                      name="profilePhotoUrl"
                      type="url"
                      defaultValue={applicant.profilePhotoUrl ?? ""}
                      placeholder="https://example.com/photo.jpg"
                      maxLength={2000}
                      disabled={submitting}
                    />
                  </Field>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsEditing(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={submitting}
                  className="bg-teal-700 hover:bg-teal-800 text-white"
                >
                  <Save className="mr-2 h-4 w-4" />
                  {submitting ? "Submitting…" : "Save & Resubmit Application"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-slate-200">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-base font-bold text-slate-900">Submitted Medical Credentials</CardTitle>
              <CardDescription className="text-xs">
                These credentials are used by the credentialing committee for license verification.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(true)}
              className="text-xs text-teal-800 border-teal-200 hover:bg-teal-50"
            >
              <FileEdit className="mr-1.5 h-3.5 w-3.5" />
              Edit Details
            </Button>
          </CardHeader>
          <CardContent className="space-y-4 divide-y divide-slate-100 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <DetailItem icon={<Stethoscope className="h-4 w-4" />} label="Specialty" value={applicant.specialty} />
              <DetailItem
                icon={<ShieldCheck className="h-4 w-4" />}
                label="License Number"
                value={`${applicant.licenseNumber} (Under Review)`}
              />
              <DetailItem
                icon={<GraduationCap className="h-4 w-4" />}
                label="Licensing Council"
                value={applicant.licenseRegion}
              />
              <DetailItem
                icon={<GraduationCap className="h-4 w-4" />}
                label="Qualifications"
                value={applicant.qualifications ?? "Not provided"}
              />
              <DetailItem
                icon={<Calendar className="h-4 w-4" />}
                label="Years of Experience"
                value={`${applicant.yearsOfExperience ?? 0} years`}
              />
              <DetailItem
                icon={<IndianRupee className="h-4 w-4" />}
                label="Consultation Fee"
                value={`₹${applicant.consultationFeeInr ?? 500}`}
              />
              <DetailItem
                icon={<Phone className="h-4 w-4" />}
                label="Contact Phone"
                value={applicant.phone ?? "Not provided"}
              />
              <DetailItem
                icon={<Building2 className="h-4 w-4" />}
                label="Clinic / Hospital"
                value={applicant.clinicName ?? "Not specified"}
              />
            </div>

            {applicant.clinicAddress && (
              <div className="pt-3">
                <DetailItem
                  icon={<Building2 className="h-4 w-4" />}
                  label="Clinic Address"
                  value={applicant.clinicAddress}
                />
              </div>
            )}

            {applicant.bio && (
              <div className="pt-3">
                <p className="text-xs font-semibold text-slate-500 mb-1">Clinical Biography</p>
                <p className="text-xs text-slate-700 bg-slate-50 p-3 rounded-lg border border-slate-100 leading-relaxed">
                  {applicant.bio}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DetailItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <span className="text-teal-700">{icon}</span>
        <span>{label}</span>
      </div>
      <p className="font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function Field({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <label htmlFor={id} className="text-xs font-medium text-slate-800">
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
    </div>
  );
}
