"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { backendUrl } from "@/lib/api";
import { loginSchema, signupSchema } from "@/lib/auth-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Mode = "login" | "signup";

export function AuthForm({ mode }: { mode: Mode }) {
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
    const parsed = mode === "signup" ? signupSchema.safeParse(raw) : loginSchema.safeParse(raw);
    if (!parsed.success) {
      setFieldErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])));
      return;
    }

    setBusy(true);
    try {
      const result = mode === "signup"
        ? await authClient.signUp.email({ name: String(raw.name), email: String(raw.email), password: String(raw.password) })
        : await authClient.signIn.email({ email: String(raw.email), password: String(raw.password) });

      if (result.error) {
        setError(result.error.message ?? "Authentication failed. Check your details and try again.");
        return;
      }

      // Do not redirect into a dashboard until the browser can read the session.
      // This catches missing/blocked session cookies instead of silently looping to /login.
      const sessionResult = await authClient.getSession();
      const session = sessionResult.data;
      if (sessionResult.error || !session?.user) {
        setError("Your credentials were accepted, but your session was not saved. Please refresh once and try again. If this continues, contact support.");
        return;
      }

      const role = (session.user as { role?: string }).role;
      let destination = role === "admin" ? "/admin" : role === "doctor" ? "/doctor/dashboard" : "/patient/dashboard";

      // If user has role 'patient', check if they are a doctor applicant awaiting review
      if (role === "patient" || !role) {
        try {
          const appRes = await fetch(`${backendUrl}/api/doctor-applications/me`, {
            credentials: "include",
            cache: "no-store",
          });
          if (appRes.ok) {
            const text = await appRes.text();
            if (text && text.trim().length > 0) {
              const app = JSON.parse(text);
              if (app && (app.status === "pending" || app.status === "rejected")) {
                destination = "/doctor/application-status";
              }
            }
          }
        } catch {
          // fallback to patient dashboard
        }
      }

      router.replace(destination);
      router.refresh();
    } catch {
      setError("We could not complete sign-in. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const signup = mode === "signup";
  return (
    <Card className="w-full max-w-md shadow-sm border-slate-200">
      <CardHeader>
        <CardTitle>{signup ? "Create your account" : "Welcome back"}</CardTitle>
        <CardDescription>
          {signup ? "Create a patient account to get started." : "Sign in to your Medrella account."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          {signup && (
            <Field id="name" label="Full name" error={fieldErrors.name}>
              <Input id="name" name="name" autoComplete="name" required maxLength={100} aria-invalid={Boolean(fieldErrors.name)} disabled={busy} />
            </Field>
          )}

          <Field id="email" label="Email address" error={fieldErrors.email}>
            <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(fieldErrors.email)} disabled={busy} />
          </Field>

          <Field id="password" label="Password" error={fieldErrors.password}>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={signup ? "new-password" : "current-password"}
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

          {signup && (
            <Field id="confirmPassword" label="Confirm password" error={fieldErrors.confirmPassword}>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password"
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
          )}

          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700 border border-red-200">{error}</p>}
          <Button type="submit" className="w-full bg-teal-700 hover:bg-teal-800 text-white" disabled={busy}>
            {busy ? "Please wait…" : signup ? "Create account" : "Log in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-600">
          {signup ? "Already have an account? " : "New to Medrella? "}
          <Link className="font-semibold text-teal-800 hover:underline" href={signup ? "/login" : "/signup"}>
            {signup ? "Log in" : "Create an account"}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      {children}
      {error && <p id={`${id}-error`} className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
