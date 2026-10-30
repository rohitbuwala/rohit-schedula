"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { loginSchema, signupSchema } from "@/lib/auth-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Mode = "login" | "signup";

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      const destination = role === "admin" ? "/admin" : role === "doctor" ? "/doctor/dashboard" : "/patient/dashboard";
      router.replace(destination);
      router.refresh();
    } catch {
      setError("We could not complete sign-in. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const signup = mode === "signup";
  return <Card className="w-full max-w-md">
    <CardHeader><CardTitle>{signup ? "Create your account" : "Welcome back"}</CardTitle><CardDescription>{signup ? "Create a patient account to get started." : "Sign in to your Schedula account."}</CardDescription></CardHeader>
    <CardContent>
      <form onSubmit={submit} noValidate className="space-y-4">
        {signup && <Field id="name" label="Full name" error={fieldErrors.name}><Input id="name" name="name" autoComplete="name" required maxLength={100} aria-invalid={Boolean(fieldErrors.name)} /></Field>}
        <Field id="email" label="Email address" error={fieldErrors.email}><Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(fieldErrors.email)} /></Field>
        <Field id="password" label="Password" error={fieldErrors.password}><Input id="password" name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} required maxLength={128} aria-invalid={Boolean(fieldErrors.password)} /></Field>
        {signup && <Field id="confirmPassword" label="Confirm password" error={fieldErrors.confirmPassword}><Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required maxLength={128} aria-invalid={Boolean(fieldErrors.confirmPassword)} /></Field>}
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Log in"}</Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">{signup ? "Already have an account? " : "New to Schedula? "}<Link className="font-semibold text-teal-800 hover:underline" href={signup ? "/login" : "/signup"}>{signup ? "Log in" : "Create an account"}</Link></p>
    </CardContent>
  </Card>;
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium text-slate-800">{label}</label>{children}{error && <p id={`${id}-error`} className="text-sm text-red-700">{error}</p>}</div>;
}
