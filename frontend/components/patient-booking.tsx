"use client";

import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { backendUrl } from "@/lib/api";
import { appointmentFormSchema } from "@/lib/appointment-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Doctor = { id: string; name: string; specialty: string; bio: string | null };
type Slot = { startsAt: string; endsAt: string };
const doctorsSchema = z.array(z.object({
  id: z.uuid(), name: z.string(), specialty: z.string(), bio: z.string().nullable(),
}));
const availabilitySchema = z.object({
  doctorProfileId: z.uuid(), date: z.iso.date(), timezone: z.literal("UTC"), durationMinutes: z.literal(30),
  slots: z.array(z.object({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }) })),
});

export function PatientBooking({ name }: { name: string }) {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [loadingDoctors, setLoadingDoctors] = useState(true);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [slotError, setSlotError] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadDoctors() {
      try {
        const response = await fetch(`${backendUrl}/api/doctors`, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error("Doctors could not be loaded. Please try again.");
        const parsed = doctorsSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Doctor profiles returned an unexpected response.");
        if (active) setDoctors(parsed.data);
      } catch (cause) {
        if (active) setLoadError(cause instanceof Error ? cause.message : "Doctors could not be loaded.");
      } finally {
        if (active) setLoadingDoctors(false);
      }
    }
    void loadDoctors();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedDoctor || !date) {
      return;
    }
    let active = true;
    async function loadSlots() {
      setLoadingSlots(true); setSlotError(""); setSlots([]); setSelectedSlot(null);
      try {
        const query = new URLSearchParams({ doctorProfileId: selectedDoctor, date });
        const response = await fetch(`${backendUrl}/api/appointments/availability?${query}`, { credentials: "include", cache: "no-store" });
        if (response.status === 401) throw new Error("Log in again to view appointment availability.");
        if (response.status === 403) throw new Error("Availability is available to patient accounts only.");
        if (!response.ok) throw new Error("Could not load appointment slots. Please try another date.");
        const parsed = availabilitySchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Availability returned an unexpected response.");
        if (active) setSlots(parsed.data.slots);
      } catch (cause) {
        if (active) setSlotError(cause instanceof Error ? cause.message : "Could not load appointment slots.");
      } finally {
        if (active) setLoadingSlots(false);
      }
    }
    void loadSlots();
    return () => { active = false; };
  }, [selectedDoctor, date, refreshKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setSuccess(""); setFieldErrors({});
    const parsed = appointmentFormSchema.safeParse({
      doctorProfileId: selectedDoctor,
      startsAt: selectedSlot?.startsAt ?? "",
      endsAt: selectedSlot?.endsAt ?? "",
    });
    if (!parsed.success) {
      setFieldErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${backendUrl}/api/appointments`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doctorProfileId: parsed.data.doctorProfileId,
          startsAt: parsed.data.startsAt,
          endsAt: parsed.data.endsAt,
        }),
      });
      if (response.status === 409) {
        setRefreshKey((value) => value + 1);
        throw new Error("That time was just booked. Choose another slot.");
      }
      if (response.status === 401) throw new Error("Your session expired. Log in again to book.");
      if (response.status === 403) throw new Error("Only patient accounts can book appointments.");
      if (!response.ok) throw new Error(response.status === 400 ? "Check the selected date and time." : "Booking failed. Please try again.");
      const result: { startsAt: string } = await response.json();
      const bookedAt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(result.startsAt));
      setSuccess(`Appointment booked for ${bookedAt} UTC.`);
      setSelectedSlot(null);
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Booking failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
    <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">Patient workspace</p>
    <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Welcome, {name}</h1>
    <p className="mt-3 text-slate-600">Choose an approved doctor and request an appointment.</p>

    <section className="mt-8" aria-labelledby="doctors-heading">
      <h2 id="doctors-heading" className="mb-4 text-xl font-semibold text-slate-900">Approved doctors</h2>
      {loadingDoctors && <p role="status" className="text-sm text-slate-600">Loading doctor profiles…</p>}
      {loadError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{loadError}</p>}
      {!loadingDoctors && !loadError && doctors.length === 0 && <p className="rounded-xl border border-slate-200 p-5 text-sm text-slate-600">No approved doctors are available yet.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {doctors.map((doctor) => <button key={doctor.id} type="button" onClick={() => { setSelectedDoctor(doctor.id); setError(""); setFieldErrors({}); }} aria-pressed={selectedDoctor === doctor.id} className={`rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${selectedDoctor === doctor.id ? "ring-2 ring-teal-700" : ""}`}>
          <Card className="h-full transition hover:border-teal-400"><CardHeader><CardTitle className="text-lg">{doctor.name}</CardTitle><CardDescription>{doctor.specialty}</CardDescription></CardHeader><CardContent><p className="text-sm leading-6 text-slate-600">{doctor.bio || "Approved Schedula doctor."}</p><span className="mt-4 inline-block text-sm font-semibold text-teal-800">{selectedDoctor === doctor.id ? "Selected" : "Select doctor"}</span></CardContent></Card>
        </button>)}
      </div>
    </section>

    <Card className="mt-8 max-w-2xl">
      <CardHeader><CardTitle>Request an appointment</CardTitle><CardDescription>Choose an available 30-minute weekday slot. Times are shown in UTC.</CardDescription></CardHeader>
      <CardContent><form onSubmit={submit} noValidate className="space-y-4">
        {!selectedDoctor && <p className="text-sm text-slate-600">Select a doctor above to continue.</p>}
        <FormField id="bookingDate" label="Date (UTC)"><Input id="bookingDate" type="date" min={new Date().toISOString().slice(0, 10)} value={date} onChange={(event) => { setDate(event.target.value); setSlots([]); setSelectedSlot(null); setSlotError(""); setSuccess(""); setError(""); }} disabled={!selectedDoctor || loadingDoctors || Boolean(loadError)} /></FormField>
        {selectedDoctor && loadingSlots && <p role="status" className="text-sm text-slate-600">Checking available slots…</p>}
        {slotError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{slotError}</p>}
        {selectedDoctor && !loadingSlots && !slotError && slots.length === 0 && <p className="text-sm text-slate-600">No available slots for this date. Try another weekday.</p>}
        {slots.length > 0 && <fieldset disabled={loadingSlots} className="space-y-2"><legend className="text-sm font-medium text-slate-800">Available start times</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{slots.map((slot) => {
          const selected = selectedSlot?.startsAt === slot.startsAt;
          const startLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(slot.startsAt));
          const endLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(slot.endsAt));
          return <button key={slot.startsAt} type="button" aria-pressed={selected} onClick={() => { setSelectedSlot(slot); setError(""); setSuccess(""); setFieldErrors({}); }} className={`min-h-11 rounded-lg border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${selected ? "border-teal-700 bg-teal-50 text-teal-900" : "border-slate-300 bg-white text-slate-800 hover:border-teal-500"}`}>{startLabel}–{endLabel} UTC</button>;
        })}</div></fieldset>}
        {fieldErrors.doctorProfileId && <p role="alert" className="text-sm text-red-700">{fieldErrors.doctorProfileId}</p>}
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {success && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{success}</p>}
        <Button type="submit" disabled={submitting || loadingDoctors || loadingSlots || Boolean(loadError) || Boolean(slotError) || !selectedDoctor || !selectedSlot}>{submitting ? "Booking…" : "Book appointment"}</Button>
      </form></CardContent>
    </Card>
  </main>;
}

function FormField({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium text-slate-800">{label}</label>{children}{error && <p className="text-sm text-red-700">{error}</p>}</div>;
}
