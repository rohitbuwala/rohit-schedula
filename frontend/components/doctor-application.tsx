"use client";

import { useEffect, useState, type FormEvent } from "react";
import { backendUrl } from "@/lib/api";
import { doctorApplicationFormSchema } from "@/lib/doctor-application-validation";
import { doctorApplicationResponseSchema, parseDoctorApplicationResponseBody, type DoctorApplicationResponse } from "@/lib/doctor-application-response";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function DoctorApplication() {
  const [application, setApplication] = useState<DoctorApplicationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    async function loadApplication() {
      try {
        const response = await fetch(`${backendUrl}/api/doctor-applications/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(response.status === 401
            ? "Your session expired. Log in again."
            : response.status === 403
              ? "Doctor applications are available to patient accounts only."
              : "Could not load your application status.");
        }
        const result = parseDoctorApplicationResponseBody(await response.text());
        if (active) {
          setApplication(result);
          setStatusLoaded(true);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load your application status.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadApplication();
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
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
      setFieldErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])));
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
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("Only patient accounts can submit doctor applications.");
      if (response.status === 409) throw new Error("An application already exists. Refresh to see its status.");
      if (!response.ok) throw new Error(response.status === 400 ? "Check the application details and try again." : "Could not submit your application. Please try again.");
      const result = doctorApplicationResponseSchema.safeParse(await response.json());
      if (!result.success) throw new Error("The application response was unexpected. Refresh to check its status.");
      setApplication(result.data);
      setSuccess("Your application was submitted for review.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit your application. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = statusLoaded && (!application || application.status === "rejected");

  return <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
    <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">Doctor application</p>
    <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Apply to join Medrella</h1>
    <p className="mt-3 text-slate-600">Submit your professional details for administrator review.</p>
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Professional details</CardTitle>
        <CardDescription>Your application is reviewed before your account can use doctor features.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && <p role="status" className="text-sm text-slate-600">Loading application status…</p>}
        {!loading && application?.status === "pending" && <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Application pending review</p>
          <p className="mt-1">Your application was submitted on {new Date(application.submittedAt).toLocaleDateString()}.</p>
        </div>}
        {!loading && application?.status === "rejected" && <div className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-semibold">Application not approved</p>
          <p className="mt-1">You can update your details and submit a new application.</p>
        </div>}
        {!loading && application?.status === "approved" && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Application approved</p>
          <p className="mt-1">Your account has been approved for doctor features.</p>
        </div>}
        {!loading && error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {!loading && success && <p role="status" className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{success}</p>}
        {!loading && canSubmit && <form onSubmit={submit} noValidate className="space-y-4">
          {/* Required fields */}
          <FormField id="specialty" label="Specialty *" error={fieldErrors.specialty}>
            <Input id="specialty" name="specialty" required maxLength={100} autoComplete="organization-title" defaultValue={application?.specialty ?? ""} aria-invalid={Boolean(fieldErrors.specialty)} />
          </FormField>
          <FormField id="licenseRegion" label="License region *" error={fieldErrors.licenseRegion}>
            <Input id="licenseRegion" name="licenseRegion" required maxLength={80} defaultValue={application?.licenseRegion ?? ""} aria-invalid={Boolean(fieldErrors.licenseRegion)} />
          </FormField>
          <FormField id="licenseNumber" label="License number *" error={fieldErrors.licenseNumber}>
            <Input id="licenseNumber" name="licenseNumber" required maxLength={80} defaultValue={application?.licenseNumber ?? ""} aria-invalid={Boolean(fieldErrors.licenseNumber)} />
          </FormField>

          {/* Optional profile fields */}
          <FormField id="bio" label="Professional bio (optional)" error={fieldErrors.bio}>
            <textarea id="bio" name="bio" rows={4} maxLength={1000} defaultValue={application?.bio ?? ""} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-teal-600" aria-invalid={Boolean(fieldErrors.bio)} />
          </FormField>
          <FormField id="qualifications" label="Qualifications / degrees (optional)" error={fieldErrors.qualifications}>
            <Input id="qualifications" name="qualifications" maxLength={500} defaultValue={application?.qualifications ?? ""} placeholder="e.g. MBBS, MD (Cardiology)" aria-invalid={Boolean(fieldErrors.qualifications)} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="yearsOfExperience" label="Years of experience (optional)" error={fieldErrors.yearsOfExperience}>
              <Input id="yearsOfExperience" name="yearsOfExperience" type="number" min="0" max="70" step="1" defaultValue={application?.yearsOfExperience ?? ""} placeholder="e.g. 10" aria-invalid={Boolean(fieldErrors.yearsOfExperience)} />
            </FormField>
            <FormField id="consultationFeeInr" label="Consultation fee ₹ (optional)" error={fieldErrors.consultationFeeInr}>
              <Input id="consultationFeeInr" name="consultationFeeInr" type="number" min="0" step="1" defaultValue={application?.consultationFeeInr ?? ""} placeholder="e.g. 500" aria-invalid={Boolean(fieldErrors.consultationFeeInr)} />
            </FormField>
          </div>
          <FormField id="phone" label="Contact phone (optional)" error={fieldErrors.phone}>
            <Input id="phone" name="phone" type="tel" maxLength={16} defaultValue={application?.phone ?? ""} placeholder="e.g. +919876543210" aria-invalid={Boolean(fieldErrors.phone)} />
          </FormField>
          <FormField id="clinicName" label="Clinic / hospital name (optional)" error={fieldErrors.clinicName}>
            <Input id="clinicName" name="clinicName" maxLength={200} defaultValue={application?.clinicName ?? ""} placeholder="e.g. City Medical Centre" aria-invalid={Boolean(fieldErrors.clinicName)} />
          </FormField>
          <FormField id="clinicAddress" label="Clinic / hospital address (optional)" error={fieldErrors.clinicAddress}>
            <Input id="clinicAddress" name="clinicAddress" maxLength={500} defaultValue={application?.clinicAddress ?? ""} placeholder="e.g. 123 Main Street, Mumbai" aria-invalid={Boolean(fieldErrors.clinicAddress)} />
          </FormField>
          <FormField id="profilePhotoUrl" label="Profile photo URL (optional)" error={fieldErrors.profilePhotoUrl}>
            <Input id="profilePhotoUrl" name="profilePhotoUrl" type="url" maxLength={2000} defaultValue={application?.profilePhotoUrl ?? ""} placeholder="https://example.com/photo.jpg" aria-invalid={Boolean(fieldErrors.profilePhotoUrl)} />
          </FormField>

          <Button type="submit" disabled={submitting}>{submitting ? "Submitting…" : application ? "Resubmit application" : "Submit application"}</Button>
        </form>}
      </CardContent>
    </Card>
  </main>;
}

function FormField({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium text-slate-800">{label}</label>{children}{error && <p className="text-sm text-red-700">{error}</p>}</div>;
}
