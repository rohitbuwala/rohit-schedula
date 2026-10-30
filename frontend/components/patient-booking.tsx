"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { z } from "zod";
import {
  Building2,
  Calendar,
  Clock,
  GraduationCap,
  HeartPulse,
  Search,
  Sparkles,
  Stethoscope,
  User,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import { appointmentFormSchema } from "@/lib/appointment-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PatientAppointments } from "@/components/patient-appointments";

type Doctor = {
  id: string;
  name: string;
  specialty: string;
  bio: string | null;
  qualifications: string | null;
  yearsOfExperience: number | null;
  consultationFeeInr: number | null;
  clinicName: string | null;
  clinicAddress: string | null;
  profilePhotoUrl: string | null;
};
type Slot = { startsAt: string; endsAt: string };

const doctorsSchema = z.array(
  z.object({
    id: z.uuid(),
    name: z.string(),
    specialty: z.string(),
    bio: z.string().nullable(),
    qualifications: z.string().nullable().optional(),
    yearsOfExperience: z.number().int().nullable().optional(),
    consultationFeeInr: z.number().int().nullable().optional(),
    clinicName: z.string().nullable().optional(),
    clinicAddress: z.string().nullable().optional(),
    profilePhotoUrl: z.string().nullable().optional(),
  })
);

const availabilitySchema = z.object({
  doctorProfileId: z.uuid(),
  date: z.iso.date(),
  timezone: z.string(),
  durationMinutes: z.number().int().positive(),
  slots: z.array(
    z.object({
      startsAt: z.iso.datetime({ offset: true }),
      endsAt: z.iso.datetime({ offset: true }),
    })
  ),
});

export function PatientBooking({ name }: { name: string }) {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [date, setDate] = useState(() =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())
  );
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

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSpecialty, setSelectedSpecialty] = useState("all");

  useEffect(() => {
    let active = true;
    async function loadDoctors() {
      try {
        const response = await fetch(`${backendUrl}/api/doctors`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Doctors could not be loaded. Please try again.");
        const parsed = doctorsSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Doctor profiles returned an unexpected response.");
        if (active) setDoctors(parsed.data as Doctor[]);
      } catch (cause) {
        if (active) setLoadError(cause instanceof Error ? cause.message : "Doctors could not be loaded.");
      } finally {
        if (active) setLoadingDoctors(false);
      }
    }
    void loadDoctors();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedDoctor || !date) {
      return;
    }
    let active = true;
    async function loadSlots() {
      setLoadingSlots(true);
      setSlotError("");
      setSlots([]);
      setSelectedSlot(null);
      try {
        const query = new URLSearchParams({ doctorProfileId: selectedDoctor, date });
        const response = await fetch(`${backendUrl}/api/appointments/availability?${query}`, {
          credentials: "include",
          cache: "no-store",
        });
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
    return () => {
      active = false;
    };
  }, [selectedDoctor, date, refreshKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setFieldErrors({});
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
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doctorProfileId: parsed.data.doctorProfileId,
          startsAt: parsed.data.startsAt,
          endsAt: parsed.data.endsAt,
        }),
      });
      if (response.status === 401) throw new Error("Your session expired. Log in again to book.");
      if (response.status === 403) throw new Error("Only patient accounts can book appointments.");
      if (!response.ok)
        throw new Error(
          response.status === 400 ? "Check the selected date and time." : "Booking failed. Please try again."
        );
      const result: { startsAt: string } = await response.json();
      const bookedAt = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(result.startsAt));
      setSuccess(`Appointment booked successfully for ${bookedAt} UTC.`);
      setSelectedSlot(null);
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Booking failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Derive unique specialties for filter tabs
  const specialties = useMemo(() => {
    const list = Array.from(new Set(doctors.map((d) => d.specialty))).filter(Boolean);
    return ["all", ...list];
  }, [doctors]);

  // Filtered doctors list
  const filteredDoctors = useMemo(() => {
    return doctors.filter((doc) => {
      const matchesSpecialty = selectedSpecialty === "all" || doc.specialty === selectedSpecialty;
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        doc.name.toLowerCase().includes(q) ||
        doc.specialty.toLowerCase().includes(q) ||
        (doc.clinicName && doc.clinicName.toLowerCase().includes(q)) ||
        (doc.qualifications && doc.qualifications.toLowerCase().includes(q));
      return matchesSpecialty && matchesSearch;
    });
  }, [doctors, selectedSpecialty, searchQuery]);

  const selectedDoctorData = doctors.find((d) => d.id === selectedDoctor) ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 space-y-8">
      {/* Welcome Banner & Healthcare Metrics */}
      <div className="rounded-3xl border border-teal-100 bg-gradient-to-br from-teal-900 via-teal-800 to-slate-900 p-6 sm:p-8 text-white shadow-lg">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-teal-700/60 px-3 py-1 text-xs font-semibold text-teal-200 backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" />
              Patient Care Workspace
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Welcome back, {name}
            </h1>
            <p className="text-teal-100/90 text-sm max-w-xl">
              Discover verified specialists, schedule conflict-free consultation slots, and track your clinical appointment history in real time.
            </p>
            <div className="pt-1">
              <Link
                href="/patient/profile"
                className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 hover:bg-white/25 px-3 py-1.5 text-xs font-semibold text-white transition border border-white/20 shadow-xs"
              >
                <User className="h-3.5 w-3.5 text-teal-200" />
                Manage Patient Profile
              </Link>
            </div>
          </div>

          <div className="flex items-center gap-4 bg-white/10 backdrop-blur rounded-2xl p-4 border border-white/15">
            <div className="text-center px-2">
              <p className="text-2xl font-extrabold text-white">{doctors.length}</p>
              <p className="text-[11px] font-medium text-teal-200 uppercase tracking-wider">
                Specialists
              </p>
            </div>
            <div className="h-8 w-px bg-white/20" />
            <div className="text-center px-2">
              <p className="text-2xl font-extrabold text-white">{specialties.length - 1}</p>
              <p className="text-[11px] font-medium text-teal-200 uppercase tracking-wider">
                Disciplines
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Doctor Discovery & Filter Controls */}
      <section aria-labelledby="doctors-heading" className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 id="doctors-heading" className="text-xl font-bold text-slate-900">
              Find a Specialist
            </h2>
            <p className="text-sm text-slate-500">
              Select an approved physician to view open consultation windows.
            </p>
          </div>

          {/* Search Box */}
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              placeholder="Search doctor, clinic, specialty…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-white"
            />
          </div>
        </div>

        {/* Specialty Filters */}
        {specialties.length > 2 && (
          <div className="flex flex-wrap items-center gap-2 pt-1" role="tablist" aria-label="Specialties">
            {specialties.map((spec) => {
              const active = selectedSpecialty === spec;
              return (
                <button
                  key={spec}
                  type="button"
                  onClick={() => setSelectedSpecialty(spec)}
                  className={`rounded-full px-3.5 py-1 text-xs font-semibold transition ${
                    active
                      ? "bg-teal-700 text-white shadow-xs"
                      : "bg-white border border-slate-200 text-slate-600 hover:border-teal-300 hover:text-teal-700"
                  }`}
                >
                  {spec === "all" ? "All Specialties" : spec}
                </button>
              );
            })}
          </div>
        )}

        {/* Doctor Grid */}
        {loadingDoctors && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            <HeartPulse className="h-6 w-6 text-teal-600 animate-pulse mx-auto mb-2" />
            Loading verified doctors…
          </div>
        )}
        {loadError && (
          <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700 border border-red-200">
            {loadError}
          </p>
        )}
        {!loadingDoctors && !loadError && filteredDoctors.length === 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
            No doctors matched your search criteria. Try a different keyword or specialty filter.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredDoctors.map((doctor) => {
            const isSelected = selectedDoctor === doctor.id;
            return (
              <button
                key={doctor.id}
                type="button"
                onClick={() => {
                  setSelectedDoctor(doctor.id);
                  setError("");
                  setFieldErrors({});
                }}
                aria-pressed={isSelected}
                className={`rounded-2xl text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
                  isSelected
                    ? "ring-2 ring-teal-700 shadow-md scale-[1.01]"
                    : "hover:border-teal-300 hover:shadow-xs"
                }`}
              >
                <Card className={`h-full border transition ${isSelected ? "border-teal-700 bg-teal-50/20" : "border-slate-200 bg-white"}`}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-teal-50 to-cyan-50 text-teal-700 border border-teal-200">
                        <Stethoscope className="h-6 w-6" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base font-bold text-slate-900 truncate">
                          {doctor.name}
                        </CardTitle>
                        <CardDescription className="text-xs font-semibold text-teal-700">
                          {doctor.specialty}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-0">
                    {doctor.qualifications && (
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <GraduationCap className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                        <span className="truncate">{doctor.qualifications}</span>
                      </div>
                    )}
                    <p className="text-xs leading-5 text-slate-600 line-clamp-2">
                      {doctor.bio || "Approved Medrella doctor."}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      {doctor.yearsOfExperience != null && (
                        <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                          {doctor.yearsOfExperience} yrs exp
                        </span>
                      )}
                      {doctor.consultationFeeInr != null && (
                        <span className="inline-flex items-center rounded-md bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800 border border-teal-200">
                          ₹{doctor.consultationFeeInr.toLocaleString("en-IN")}
                        </span>
                      )}
                    </div>
                    {doctor.clinicName && (
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 border-t border-slate-100 pt-2">
                        <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                        <span className="truncate">{doctor.clinicName}</span>
                      </div>
                    )}
                    <div className="pt-2">
                      <span
                        className={`inline-block text-xs font-bold rounded-lg px-3 py-1.5 w-full text-center transition ${
                          isSelected
                            ? "bg-teal-700 text-white"
                            : "bg-slate-100 text-slate-700 group-hover:bg-teal-50"
                        }`}
                      >
                        {isSelected ? "Selected for Booking" : "Select Doctor"}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </button>
            );
          })}
        </div>
      </section>

      {/* Selected Doctor Summary Card */}
      {selectedDoctorData && (
        <Card className="border-teal-200 bg-teal-50/50">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-bold text-slate-900">
                  Active Selection: {selectedDoctorData.name}
                </CardTitle>
                <CardDescription className="text-xs font-semibold text-teal-700">
                  {selectedDoctorData.specialty}
                </CardDescription>
              </div>
              <span className="rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-semibold text-teal-800">
                Ready to Schedule
              </span>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs sm:grid-cols-2 text-slate-700 pt-2 border-t border-teal-100">
            {selectedDoctorData.consultationFeeInr != null && (
              <p>
                <span className="font-semibold text-slate-900">Consultation Fee:</span> ₹
                {selectedDoctorData.consultationFeeInr.toLocaleString("en-IN")}
              </p>
            )}
            {selectedDoctorData.yearsOfExperience != null && (
              <p>
                <span className="font-semibold text-slate-900">Experience:</span>{" "}
                {selectedDoctorData.yearsOfExperience} year
                {selectedDoctorData.yearsOfExperience !== 1 ? "s" : ""}
              </p>
            )}
            {selectedDoctorData.clinicName && (
              <p className="sm:col-span-2">
                <span className="font-semibold text-slate-900">Clinic:</span>{" "}
                {selectedDoctorData.clinicName}{" "}
                {selectedDoctorData.clinicAddress ? `(${selectedDoctorData.clinicAddress})` : ""}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Booking Form Card */}
      <Card className="border-slate-200 bg-white shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-teal-700" />
            <CardTitle className="text-lg font-bold text-slate-900">
              Schedule Consultation Slot
            </CardTitle>
          </div>
          <CardDescription>
            Select an available consultation window. Times are presented in IST (Asia/Kolkata).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} noValidate className="space-y-5">
            {!selectedDoctor && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-medium text-amber-800">
                Please select a doctor from the directory above to review their available appointment slots.
              </div>
            )}

            <FormField id="bookingDate" label="Consultation Date (IST)">
              <Input
                id="bookingDate"
                type="date"
                min={new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                  setSlots([]);
                  setSelectedSlot(null);
                  setSlotError("");
                  setSuccess("");
                  setError("");
                }}
                disabled={!selectedDoctor || loadingDoctors || Boolean(loadError)}
                className="max-w-xs"
              />
            </FormField>

            {selectedDoctor && loadingSlots && (
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <Clock className="h-4 w-4 animate-spin text-teal-700" />
                Querying doctor availability…
              </div>
            )}

            {slotError && (
              <p role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-700 border border-red-200">
                {slotError}
              </p>
            )}

            {selectedDoctor && !loadingSlots && !slotError && slots.length === 0 && (
              <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                No slots available on this date. Please pick another date or weekday.
              </p>
            )}

            {slots.length > 0 && (
              <fieldset disabled={loadingSlots} className="space-y-2">
                <legend className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Available consultation windows (IST)
                </legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {slots.map((slot) => {
                    const isSelected = selectedSlot?.startsAt === slot.startsAt;
                    const startLabel = new Intl.DateTimeFormat(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: "Asia/Kolkata",
                    }).format(new Date(slot.startsAt));
                    const endLabel = new Intl.DateTimeFormat(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: "Asia/Kolkata",
                    }).format(new Date(slot.endsAt));
                    return (
                      <button
                        key={slot.startsAt}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => {
                          setSelectedSlot(slot);
                          setError("");
                          setSuccess("");
                          setFieldErrors({});
                        }}
                        className={`min-h-11 rounded-xl border px-3 text-xs font-semibold transition ${
                          isSelected
                            ? "border-teal-700 bg-teal-700 text-white shadow-xs"
                            : "border-slate-200 bg-white text-slate-700 hover:border-teal-400 hover:bg-teal-50/50"
                        }`}
                      >
                        {startLabel} – {endLabel} IST
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}

            {fieldErrors.doctorProfileId && (
              <p role="alert" className="text-xs text-red-700">{fieldErrors.doctorProfileId}</p>
            )}
            {error && (
              <p role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-700 border border-red-200">
                {error}
              </p>
            )}
            {success && (
              <p role="status" className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800 border border-emerald-200 font-medium">
                {success}
              </p>
            )}

            <Button
              type="submit"
              disabled={
                submitting ||
                loadingDoctors ||
                loadingSlots ||
                Boolean(loadError) ||
                Boolean(slotError) ||
                !selectedDoctor ||
                !selectedSlot
              }
              className="bg-teal-700 hover:bg-teal-800 text-white font-semibold"
            >
              {submitting ? "Confirming booking…" : "Book appointment"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Appointment History & Cancellation */}
      <PatientAppointments
        refreshKey={refreshKey}
        onCancelled={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}

function FormField({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wider text-slate-700">
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
