"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { readStaffRegistration, registerStaff } from "@/lib/staff-access-api";
import { useQueueResource } from "@/components/use-appointment-queue";
import { Button } from "@/components/ui/button";

export function StaffRegistrationForm() {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  return <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h1 className="text-2xl font-bold text-slate-950">Register as Staff</h1>
    <p className="mt-2 text-sm text-slate-600">Create a dedicated staff account. An administrator must approve your request and assign a doctor before you can manage patient check-ins.</p>
    {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {created ? <p role="status" className="mt-5 text-sm">Your request was submitted. <Link href="/login" className="font-semibold text-teal-800 underline">Sign in</Link> to check approval status.</p> :
      <form className="mt-6 space-y-4" onSubmit={async event => {
        event.preventDefault(); if (busy) return; const form = event.currentTarget; const values = new FormData(form);
        const input = { name: String(values.get("name")).trim(), email: String(values.get("email")).trim().toLowerCase(), password: String(values.get("password")) };
        if (input.password !== values.get("confirmation")) { setError("Passwords must match."); return; }
        setBusy(true); setError("");
        try {
          await registerStaff(input); setCreated(true); form.reset();
          const result = await authClient.signIn.email({ email: input.email, password: input.password });
          if (!result.error) { router.replace("/staff/dashboard"); router.refresh(); }
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Registration failed. Try again later."); }
        finally { setBusy(false); }
      }}>
        <label className="block text-sm font-medium">Full name<input name="name" required maxLength={100} autoComplete="name" disabled={busy} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        <label className="block text-sm font-medium">Email<input name="email" type="email" required maxLength={254} autoComplete="email" disabled={busy} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        <label className="block text-sm font-medium">Password<input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" disabled={busy} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        <label className="block text-sm font-medium">Confirm password<input name="confirmation" type="password" required minLength={8} maxLength={128} autoComplete="new-password" disabled={busy} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        <Button className="w-full" type="submit" disabled={busy}>{busy ? "Submitting…" : "Request staff access"}</Button>
      </form>}
    <p className="mt-5 text-sm text-slate-600">Already registered? <Link href="/login" className="font-semibold text-teal-800 underline">Log in</Link></p>
  </section>;
}

export function StaffAccessGate({ children }: { children: ReactNode }) {
  const status = useQueueResource("staff-registration", readStaffRegistration);
  if (status.data?.status === "approved") return children;
  return <section className="mx-auto max-w-xl space-y-4 p-8">
    <h1 className="text-2xl font-bold">{status.data?.status === "pending" ? "Waiting for admin approval" : "Checking staff access"}</h1>
    <p className="text-sm text-slate-600">Your administrator will review your request and assign the doctor you support. Patient check-in and queue access are unavailable until then.</p>
    {status.error && <p role="alert" className="text-sm text-rose-800">{status.error}</p>}
    <Button type="button" variant="outline" onClick={status.refresh}>Check approval status</Button>
  </section>;
}
