"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Eye,
  EyeOff,
  Stethoscope,
  GraduationCap,
  Building2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { backendUrl } from "@/lib/api";
import { doctorRegistrationSchema, type DoctorRegistrationInput } from "@/lib/auth-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function DoctorSignupForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [accountCreated, setAccountCreated] = useState(false);
  const [cachedPayload, setCachedPayload] = useState<DoctorRegistrationInput | null>(null);

  async function submitApplication(data: DoctorRegistrationInput) {
    const payload = {
      specialty: data.specialty,
      licenseRegion: data.licenseRegion,
      licenseNumber: data.licenseNumber,
      qualifications: data.qualifications,
      yearsOfExperience: data.yearsOfExperience,
      consultationFeeInr: data.consultationFeeInr ?? 500,
      phone: data.phone,
      clinicName: data.clinicName || null,
      clinicAddress: data.clinicAddress || null,
      bio: data.bio || null,
    };

    const response = await fetch(`${backendUrl}/api/doctor-applications`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.status === 401) {
      throw new Error("Your session expired. Please log in to complete your doctor application.");
    }
    if (response.status === 409) {
      // Application already recorded; proceed to status page
      return;
    }
    if (!response.ok) {
      const errData = await response.json().catch(() => null);
      const detail = errData?.message
        ? Array.isArray(errData.message)
          ? errData.message.join(", ")
          : String(errData.message)
        : "Failed to submit medical credentials.";
      throw new Error(detail);
    }
  }

  async function retryApplicationSubmission() {
    if (!cachedPayload) return;
    setBusy(true);
    setError("");
    try {
      await submitApplication(cachedPayload);
      router.replace("/doctor/application-status");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not submit credentials. You can log in and submit them from your dashboard."
      );
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const raw = Object.fromEntries(form.entries());
    const parsed = doctorRegistrationSchema.safeParse(raw);

    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]))
      );
      return;
    }

    setBusy(true);
    setCachedPayload(parsed.data);

    try {
      // Step 1: Create user account via Better Auth
      const signupResult = await authClient.signUp.email({
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
      });

      if (signupResult.error) {
        setError(signupResult.error.message ?? "Registration failed. Please verify your details.");
        setBusy(false);
        return;
      }

      setAccountCreated(true);

      // Verify session
      const sessionResult = await authClient.getSession();
      if (sessionResult.error || !sessionResult.data?.user) {
        setError(
          "Your account was created, but session initialization took longer than expected. Please log in to finish your doctor profile."
        );
        setBusy(false);
        return;
      }

      // Step 2: Submit doctor credentials application
      await submitApplication(parsed.data);

      // Successfully submitted application, forward to status page
      router.replace("/doctor/application-status");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Account created, but we could not submit your credentials right now. Click below to retry."
      );
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-2xl shadow-sm border-slate-200">
      <CardHeader className="space-y-1">
        <div className="flex items-center gap-2 text-teal-700 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 border border-teal-200">
            <Stethoscope className="h-4 w-4" />
          </div>
          <span className="text-xs font-semibold uppercase tracking-wider">Healthcare Professional</span>
        </div>
        <CardTitle className="text-2xl font-bold tracking-tight text-slate-900">
          Doctor Onboarding & Registration
        </CardTitle>
        <CardDescription className="text-slate-600">
          Join Medrella to consult with patients, manage your schedule, and grow your medical practice.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {accountCreated && error ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3 mb-6">
            <div className="flex items-start gap-2 text-amber-800">
              <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Account created successfully</p>
                <p className="text-xs text-amber-700 mt-0.5">{error}</p>
              </div>
            </div>
            <Button
              type="button"
              onClick={retryApplicationSubmission}
              disabled={busy}
              className="w-full bg-teal-700 hover:bg-teal-800 text-white text-sm"
            >
              {busy ? "Submitting credentials…" : "Retry Submitting Medical Credentials"}
            </Button>
          </div>
        ) : null}

        <form onSubmit={submit} noValidate className="space-y-6">
          {/* Section 1: Account Credentials */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-100 text-[11px] font-bold text-teal-800">
                1
              </span>
              <h3 className="text-sm font-semibold text-slate-900">Account Credentials</h3>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="name" label="Full name" error={fieldErrors.name} className="sm:col-span-2">
                <Input
                  id="name"
                  name="name"
                  autoComplete="name"
                  placeholder="Dr. Rajesh Gupta"
                  required
                  maxLength={100}
                  aria-invalid={Boolean(fieldErrors.name)}
                  disabled={busy}
                />
              </Field>

              <Field id="email" label="Email address" error={fieldErrors.email}>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="doctor@hospital.org"
                  required
                  aria-invalid={Boolean(fieldErrors.email)}
                  disabled={busy}
                />
              </Field>

              <Field id="phone" label="Contact phone" error={fieldErrors.phone}>
                <Input
                  id="phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+91 98765 43210"
                  required
                  aria-invalid={Boolean(fieldErrors.phone)}
                  disabled={busy}
                />
              </Field>

              <Field id="password" label="Password" error={fieldErrors.password}>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="Min. 8 characters"
                    required
                    maxLength={128}
                    aria-invalid={Boolean(fieldErrors.password)}
                    disabled={busy}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none"
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>

              <Field id="confirmPassword" label="Confirm password" error={fieldErrors.confirmPassword}>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    name="confirmPassword"
                    type={showConfirmPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="Confirm password"
                    required
                    maxLength={128}
                    aria-invalid={Boolean(fieldErrors.confirmPassword)}
                    disabled={busy}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none"
                    tabIndex={-1}
                    aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                  >
                    {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>
            </div>
          </div>

          {/* Section 2: Medical Credentials & Qualifications */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-100 text-[11px] font-bold text-teal-800">
                2
              </span>
              <div className="flex items-center gap-1.5">
                <GraduationCap className="h-4 w-4 text-teal-700" />
                <h3 className="text-sm font-semibold text-slate-900">Medical Credentials</h3>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="specialty" label="Medical specialty" error={fieldErrors.specialty}>
                <Input
                  id="specialty"
                  name="specialty"
                  placeholder="e.g. Cardiology, Dermatology"
                  required
                  maxLength={100}
                  aria-invalid={Boolean(fieldErrors.specialty)}
                  disabled={busy}
                />
              </Field>

              <Field id="qualifications" label="Degrees & qualifications" error={fieldErrors.qualifications}>
                <Input
                  id="qualifications"
                  name="qualifications"
                  placeholder="e.g. MBBS, MD (Cardiology)"
                  required
                  maxLength={500}
                  aria-invalid={Boolean(fieldErrors.qualifications)}
                  disabled={busy}
                />
              </Field>

              <Field
                id="licenseRegion"
                label="Licensing council / state"
                hint="e.g. NMC, Maharashtra Council"
                error={fieldErrors.licenseRegion}
              >
                <Input
                  id="licenseRegion"
                  name="licenseRegion"
                  placeholder="National Medical Commission"
                  required
                  maxLength={80}
                  aria-invalid={Boolean(fieldErrors.licenseRegion)}
                  disabled={busy}
                />
              </Field>

              <Field id="licenseNumber" label="Registration / license number" error={fieldErrors.licenseNumber}>
                <Input
                  id="licenseNumber"
                  name="licenseNumber"
                  placeholder="e.g. MCI-2018-98765"
                  required
                  maxLength={80}
                  aria-invalid={Boolean(fieldErrors.licenseNumber)}
                  disabled={busy}
                />
              </Field>

              <Field id="yearsOfExperience" label="Years of experience" error={fieldErrors.yearsOfExperience}>
                <Input
                  id="yearsOfExperience"
                  name="yearsOfExperience"
                  type="number"
                  min={0}
                  max={70}
                  defaultValue={5}
                  required
                  aria-invalid={Boolean(fieldErrors.yearsOfExperience)}
                  disabled={busy}
                />
              </Field>

              <Field
                id="consultationFeeInr"
                label="Consultation fee (₹ INR)"
                hint="Default: 500"
                error={fieldErrors.consultationFeeInr}
              >
                <Input
                  id="consultationFeeInr"
                  name="consultationFeeInr"
                  type="number"
                  min={0}
                  defaultValue={500}
                  aria-invalid={Boolean(fieldErrors.consultationFeeInr)}
                  disabled={busy}
                />
              </Field>
            </div>
          </div>

          {/* Section 3: Practice Information (Optional) */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-100 text-[11px] font-bold text-teal-800">
                3
              </span>
              <div className="flex items-center gap-1.5">
                <Building2 className="h-4 w-4 text-teal-700" />
                <h3 className="text-sm font-semibold text-slate-900">Practice Details (Optional)</h3>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="clinicName" label="Clinic / Hospital name" error={fieldErrors.clinicName}>
                <Input
                  id="clinicName"
                  name="clinicName"
                  placeholder="e.g. Apollo Medical Center"
                  maxLength={200}
                  aria-invalid={Boolean(fieldErrors.clinicName)}
                  disabled={busy}
                />
              </Field>

              <Field id="clinicAddress" label="Clinic address" error={fieldErrors.clinicAddress}>
                <Input
                  id="clinicAddress"
                  name="clinicAddress"
                  placeholder="e.g. 102 Park Street, Bengaluru"
                  maxLength={500}
                  aria-invalid={Boolean(fieldErrors.clinicAddress)}
                  disabled={busy}
                />
              </Field>

              <Field id="bio" label="Professional summary" error={fieldErrors.bio} className="sm:col-span-2">
                <Input
                  id="bio"
                  name="bio"
                  placeholder="Short summary of clinical expertise, special interests, and approach to care."
                  maxLength={1000}
                  aria-invalid={Boolean(fieldErrors.bio)}
                  disabled={busy}
                />
              </Field>
            </div>
          </div>

          {error && !accountCreated && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700 border border-red-200">
              {error}
            </p>
          )}

          <Button
            type="submit"
            className="w-full bg-teal-700 hover:bg-teal-800 text-white font-medium py-2.5"
            disabled={busy}
          >
            {busy ? "Submitting Application…" : "Register & Submit for Approval"}
          </Button>

          <div className="rounded-lg bg-teal-50/60 p-3.5 text-xs text-slate-600 border border-teal-100 flex items-start gap-2.5">
            <CheckCircle2 className="h-4 w-4 text-teal-700 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-slate-900">Credential Verification Notice</p>
              <p className="mt-0.5">
                To safeguard patient care, Medrella administrators verify medical council licenses before elevating your
                account to verified Doctor status. You can monitor your application status anytime.
              </p>
            </div>
          </div>
        </form>

        <div className="mt-6 space-y-2 border-t border-slate-100 pt-5 text-center text-sm">
          <p className="text-slate-600">
            Looking to book an appointment?{" "}
            <Link className="font-semibold text-teal-700 hover:underline" href="/signup/patient">
              Register as Patient
            </Link>
          </p>
          <p className="text-slate-600">
            Already have an account?{" "}
            <Link className="font-semibold text-teal-700 hover:underline" href="/login">
              Log in
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium text-slate-800">
          {label}
        </label>
        {hint && <span className="text-xs text-slate-500">{hint}</span>}
      </div>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
