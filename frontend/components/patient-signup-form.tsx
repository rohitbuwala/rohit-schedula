"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, User, CheckCircle2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { backendUrl } from "@/lib/api";
import { patientSignupSchema } from "@/lib/auth-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function PatientSignupForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const raw = Object.fromEntries(form.entries());
    const parsed = patientSignupSchema.safeParse(raw);

    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]))
      );
      return;
    }

    setBusy(true);
    try {
      const result = await authClient.signUp.email({
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
      });

      if (result.error) {
        setError(result.error.message ?? "Registration failed. Please check your details and try again.");
        setBusy(false);
        return;
      }

      // Verify that session was established
      const sessionResult = await authClient.getSession();
      if (sessionResult.error || !sessionResult.data?.user) {
        setError("Your account was created, but the session could not be established. Please proceed to log in.");
        setBusy(false);
        return;
      }

      // If patient provided a phone number, update their profile
      if (parsed.data.phone && parsed.data.phone.trim().length > 0) {
        try {
          await fetch(`${backendUrl}/api/patients/me`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: parsed.data.phone.trim() }),
          });
        } catch {
          // Non-blocking: phone can be updated later from profile
        }
      }

      router.replace("/patient/dashboard");
      router.refresh();
    } catch {
      setError("We could not complete your registration. Please check your network connection and try again.");
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-lg shadow-sm border-slate-200">
      <CardHeader className="space-y-1">
        <div className="flex items-center gap-2 text-teal-700 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 border border-teal-200">
            <User className="h-4 w-4" />
          </div>
          <span className="text-xs font-semibold uppercase tracking-wider">Patient Registration</span>
        </div>
        <CardTitle className="text-2xl font-bold tracking-tight text-slate-900">
          Create Patient Account
        </CardTitle>
        <CardDescription className="text-slate-600">
          Book appointments, consult with doctors, and manage your health records.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field id="name" label="Full name" error={fieldErrors.name}>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              placeholder="e.g. Priya Sharma"
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
              placeholder="priya@example.com"
              required
              aria-invalid={Boolean(fieldErrors.email)}
              disabled={busy}
            />
          </Field>

          <Field
            id="phone"
            label="Phone number"
            hint="Optional — used for SMS appointment reminders."
            error={fieldErrors.phone}
          >
            <Input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+91 98765 43210"
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
                placeholder="At least 8 characters"
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
                placeholder="Re-enter your password"
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

          {error && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700 border border-red-200">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full bg-teal-700 hover:bg-teal-800 text-white font-medium py-2.5" disabled={busy}>
            {busy ? "Creating account…" : "Register as Patient"}
          </Button>

          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 border border-slate-200 flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-teal-700 shrink-0 mt-0.5" />
            <span>
              By registering, your account is immediately activated so you can find doctors and schedule appointments.
            </span>
          </div>
        </form>

        <div className="mt-6 space-y-2 border-t border-slate-100 pt-5 text-center text-sm">
          <p className="text-slate-600">
            Are you a healthcare professional?{" "}
            <Link className="font-semibold text-teal-700 hover:underline" href="/signup/doctor">
              Register as Doctor
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
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
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
