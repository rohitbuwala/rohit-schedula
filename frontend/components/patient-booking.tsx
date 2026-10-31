"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { z } from "zod";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Calendar,
  CalendarCheck,
  CheckCircle2,
  Clock,
  GraduationCap,
  HeartPulse,
  Info,
  Search,
  ShieldCheck,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import { appointmentFormSchema } from "@/lib/appointment-validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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

export function PatientBooking({ name }: { name?: string }) {
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

  const [currentTime] = useState(() => Date.now());

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSpecialty, setSelectedSpecialty] = useState("all");

  // Exclude past consultation windows
  const availableSlots = useMemo(() => {
    return slots.filter((slot) => new Date(slot.startsAt).getTime() > currentTime);
  }, [slots, currentTime]);

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
      const errors = Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
      setFieldErrors(errors);
      const firstErrorMessage = parsed.error.issues[0]?.message || "Please check the selected slot.";
      setError(firstErrorMessage);
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

      if (!response.ok) {
        let serverMessage = "";
        try {
          const data = await response.json();
          if (typeof data?.message === "string") {
            serverMessage = data.message;
          } else if (Array.isArray(data?.message)) {
            serverMessage = data.message.join(", ");
          } else if (data?.message?.formErrors?.length) {
            serverMessage = data.message.formErrors.join(", ");
          } else if (data?.message?.fieldErrors) {
            const issues: string[] = [];
            for (const msgs of Object.values(data.message.fieldErrors)) {
              if (Array.isArray(msgs) && msgs.length) {
                issues.push(msgs[0]);
              }
            }
            if (issues.length) serverMessage = issues.join("; ");
          } else if (typeof data?.error === "string") {
            serverMessage = data.error;
          }
        } catch {
          // ignore json error
        }

        if (response.status === 401) throw new Error("Your session expired. Log in again to book.");
        if (response.status === 403) throw new Error("Only patient accounts can book appointments.");
        if (response.status === 404) throw new Error(serverMessage || "The selected doctor could not be found.");
        if (response.status === 409) {
          throw new Error(serverMessage || "The selected time slot is already booked. Please choose another slot.");
        }
        throw new Error(
          serverMessage || (response.status === 400 ? "Check the selected date and time." : "Booking failed. Please try again.")
        );
      }

      const result: { startsAt: string } = await response.json();
      const bookedAt = new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
      }).format(new Date(result.startsAt));

      setSuccess(`Appointment booked successfully for ${bookedAt} IST.`);
      setSelectedSlot(null);
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Booking failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Specialties list
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

  function formatSlotDisplay(startsAt: string, endsAt: string) {
    const start = new Intl.DateTimeFormat("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
    }).format(new Date(startsAt));
    const end = new Intl.DateTimeFormat("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
    }).format(new Date(endsAt));
    return `${start} – ${end} IST`;
  }

  function formatReviewDate(dateStr: string) {
    try {
      const parts = dateStr.split("-").map(Number);
      if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        return new Intl.DateTimeFormat("en-IN", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }).format(d);
      }
      return dateStr;
    } catch {
      return dateStr;
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-8 space-y-8">
      {/* Top Breadcrumb & Page Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
          <Link href="/patient/dashboard" className="hover:text-teal-700 transition flex items-center gap-1">
            <ArrowLeft className="h-3.5 w-3.5" />
            Dashboard Overview
          </Link>
          <span>/</span>
          <span className="text-slate-900 font-semibold">Book an Appointment</span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
              Schedule a Consultation
            </h1>
            <p className="text-sm text-slate-500">
              {name ? `Welcome, ${name}. ` : ""}Select an approved physician, inspect verified credentials, and book real-time consultation windows in Asia/Kolkata (IST).
            </p>
          </div>
          <Link
            href="/patient/dashboard"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition shadow-xs self-start sm:self-auto"
          >
            <CalendarCheck className="h-4 w-4 text-teal-700" />
            View My Appointments
          </Link>
        </div>
      </div>

      {/* Balanced Two-Column Booking Experience */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Doctor Discovery (7 Cols) */}
        <section aria-labelledby="doctor-search-heading" className="lg:col-span-7 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 id="doctor-search-heading" className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Stethoscope className="h-5 w-5 text-teal-700" />
                Step 1: Choose a Doctor
              </h2>
              <p className="text-xs text-slate-500">
                {filteredDoctors.length} specialist{filteredDoctors.length !== 1 ? "s" : ""} available for scheduling
              </p>
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search name, clinic, specialty…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-white text-xs h-9"
              />
            </div>
          </div>

          {/* Specialty Filter Tabs */}
          {specialties.length > 2 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1" role="tablist" aria-label="Specialty filters">
              {specialties.map((spec) => {
                const active = selectedSpecialty === spec;
                return (
                  <button
                    key={spec}
                    type="button"
                    onClick={() => setSelectedSpecialty(spec)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
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

          {/* Doctors Loading & Error States */}
          {loadingDoctors && (
            <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500 shadow-xs">
              <HeartPulse className="h-7 w-7 text-teal-600 animate-pulse mx-auto mb-2" />
              Loading verified doctors directory…
            </div>
          )}

          {loadError && (
            <div role="alert" className="rounded-2xl bg-red-50 p-4 text-sm text-red-700 border border-red-200">
              {loadError}
            </div>
          )}

          {!loadingDoctors && !loadError && filteredDoctors.length === 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-600 shadow-xs space-y-2">
              <Stethoscope className="h-8 w-8 text-slate-300 mx-auto" />
              <p className="font-semibold text-slate-900">No doctors matched your search</p>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Try adjusting your search keywords or switch to &quot;All Specialties&quot;.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchQuery("");
                  setSelectedSpecialty("all");
                }}
                className="mt-2 text-xs"
              >
                Reset Search Filters
              </Button>
            </div>
          )}

          {/* Doctor Cards Grid */}
          <div className="grid gap-4 sm:grid-cols-2">
            {filteredDoctors.map((doctor) => {
              const isSelected = selectedDoctor === doctor.id;
              return (
                <div
                  key={doctor.id}
                  onClick={() => {
                    setSelectedDoctor(doctor.id);
                    setError("");
                    setSuccess("");
                    setFieldErrors({});
                  }}
                  className={`rounded-2xl text-left transition cursor-pointer border ${
                    isSelected
                      ? "ring-2 ring-teal-700 border-teal-700 bg-teal-50/30 shadow-md scale-[1.01]"
                      : "border-slate-200 bg-white hover:border-teal-300 hover:shadow-xs"
                  }`}
                >
                  <div className="p-4 sm:p-5 flex flex-col justify-between h-full space-y-3">
                    <div className="space-y-2.5">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-teal-50 to-cyan-50 text-teal-700 border border-teal-200">
                          <Stethoscope className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-bold text-slate-900 truncate">
                            {doctor.name}
                          </h3>
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 border border-emerald-200">
                            <ShieldCheck className="h-3 w-3 text-emerald-600" />
                            Verified Doctor
                          </span>
                          <span className="inline-block text-[11px] font-semibold text-teal-700">
                            {doctor.specialty}
                          </span>
                        </div>
                      </div>

                      {doctor.qualifications && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                          <GraduationCap className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span className="truncate">{doctor.qualifications}</span>
                        </div>
                      )}

                      <p className="text-xs leading-relaxed text-slate-600 line-clamp-2">
                        {doctor.bio || "Approved Medrella medical practitioner."}
                      </p>

                      <div className="flex flex-wrap items-center gap-2 pt-1">
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
                    </div>

                    <div className="pt-2">
                      <button
                        type="button"
                        className={`w-full text-xs font-bold rounded-xl py-2 px-3 text-center transition ${
                          isSelected
                            ? "bg-teal-700 text-white shadow-xs"
                            : "bg-slate-100 text-slate-700 hover:bg-teal-50 hover:text-teal-800"
                        }`}
                      >
                        {isSelected ? "Selected for Consultation ✓" : "Select Doctor"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Right Column: Scheduling & Booking Review (5 Cols) */}
        <section aria-labelledby="schedule-heading" className="lg:col-span-5 space-y-5 lg:sticky lg:top-24">
          <Card className="border-slate-200 bg-white shadow-sm overflow-hidden">
            <CardHeader className="bg-gradient-to-r from-teal-50/50 to-white border-b border-slate-100 pb-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-teal-700" />
                <CardTitle id="schedule-heading" className="text-base font-bold text-slate-900">
                  Step 2 & 3: Select Date & Time
                </CardTitle>
              </div>
              <CardDescription className="text-xs text-slate-500">
                All consultation hours operate between 09:00 and 17:00 IST.
              </CardDescription>
            </CardHeader>

            <CardContent className="p-5 space-y-5">
              {/* Doctor Selection Summary */}
              {selectedDoctorData ? (
                <div className="rounded-xl border border-teal-200 bg-teal-50/40 p-3.5 space-y-1 text-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-teal-900 text-sm">{selectedDoctorData.name}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 border border-emerald-200">
                        <ShieldCheck className="h-3 w-3 text-emerald-600" />
                        Verified Doctor
                      </span>
                    </div>
                    <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-800">
                      Active Selection
                    </span>
                  </div>
                  <p className="text-teal-700 font-semibold">{selectedDoctorData.specialty}</p>
                  <p className="text-slate-600">
                    Fee: ₹{selectedDoctorData.consultationFeeInr?.toLocaleString("en-IN") ?? 500}
                    {selectedDoctorData.clinicName ? ` • ${selectedDoctorData.clinicName}` : ""}
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-medium text-amber-800 flex items-start gap-2.5">
                  <Info className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">No doctor selected</p>
                    <p className="text-amber-700 mt-0.5">
                      Please choose a physician from the directory to review their available appointment slots.
                    </p>
                  </div>
                </div>
              )}

              <form onSubmit={submit} noValidate className="space-y-5">
                {/* Date Input */}
                <div className="space-y-1.5">
                  <label htmlFor="bookingDate" className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    Consultation Date (IST)
                  </label>
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
                    className="w-full bg-white text-xs h-10"
                  />
                  <p className="text-[11px] text-slate-400">
                    {formatReviewDate(date)}
                  </p>
                </div>

                {/* Slot Loading Indicator */}
                {selectedDoctor && loadingSlots && (
                  <div className="flex items-center gap-2 text-xs text-slate-600 p-3 rounded-xl bg-slate-50 border border-slate-100">
                    <Clock className="h-4 w-4 animate-spin text-teal-700" />
                    Querying physician availability for {date}…
                  </div>
                )}

                {/* Slot Error */}
                {slotError && (
                  <p role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-700 border border-red-200">
                    {slotError}
                  </p>
                )}

                {/* Empty Slots */}
                {selectedDoctor && !loadingSlots && !slotError && availableSlots.length === 0 && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600 text-center space-y-1">
                    <p className="font-semibold text-slate-800">No remaining slots on this date</p>
                    <p className="text-[11px] text-slate-500">
                      Slots may have already passed for today, or the doctor is unavailable. Please select another weekday.
                    </p>
                  </div>
                )}

                {/* Slots Grid */}
                {availableSlots.length > 0 && (
                  <fieldset disabled={loadingSlots} className="space-y-2">
                    <legend className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      Available Consultation Windows (IST)
                    </legend>
                    <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                      {availableSlots.map((slot) => {
                        const isSelected = selectedSlot?.startsAt === slot.startsAt;
                        const label = formatSlotDisplay(slot.startsAt, slot.endsAt);
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
                            className={`min-h-11 rounded-xl border px-2.5 py-2 text-xs font-semibold text-center transition ${
                              isSelected
                                ? "border-teal-700 bg-teal-700 text-white shadow-xs font-bold"
                                : "border-slate-200 bg-white text-slate-700 hover:border-teal-400 hover:bg-teal-50/50"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                )}

                {/* Review Details Card */}
                {selectedDoctorData && selectedSlot && (
                  <div className="rounded-2xl border border-teal-200 bg-gradient-to-br from-teal-50/60 to-white p-4 space-y-2.5 text-xs text-slate-700">
                    <div className="flex items-center gap-1.5 font-bold text-slate-900 border-b border-teal-100 pb-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-teal-700" />
                      Review Consultation Details
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Specialist:</span>
                        <span className="font-semibold text-slate-900">{selectedDoctorData.name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Discipline:</span>
                        <span className="font-semibold text-teal-800">{selectedDoctorData.specialty}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Consultation Date:</span>
                        <span className="font-semibold text-slate-900">{formatReviewDate(date)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Time Window:</span>
                        <span className="font-semibold text-teal-800">
                          {formatSlotDisplay(selectedSlot.startsAt, selectedSlot.endsAt)}
                        </span>
                      </div>
                      <div className="flex justify-between border-t border-teal-100 pt-1.5">
                        <span className="text-slate-700 font-bold">Consultation Fee:</span>
                        <span className="font-bold text-teal-900 text-sm">
                          ₹{selectedDoctorData.consultationFeeInr?.toLocaleString("en-IN") ?? 500}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Form & Server Validation Alerts */}
                {fieldErrors.doctorProfileId && (
                  <p role="alert" className="text-xs text-red-700">{fieldErrors.doctorProfileId}</p>
                )}
                {fieldErrors.startsAt && (
                  <p role="alert" className="text-xs text-red-700">{fieldErrors.startsAt}</p>
                )}
                {error && (
                  <div role="alert" className="rounded-xl bg-red-50 p-3.5 text-xs text-red-700 border border-red-200">
                    <p className="font-semibold">Unable to book appointment</p>
                    <p className="mt-0.5">{error}</p>
                  </div>
                )}
                {success && (
                  <div role="status" className="rounded-xl bg-emerald-50 p-4 text-xs text-emerald-900 border border-emerald-200 space-y-2">
                    <div className="flex items-center gap-2 font-bold text-emerald-800">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                      Consultation Successfully Scheduled!
                    </div>
                    <p>{success}</p>
                    <div className="pt-2 flex flex-wrap gap-2">
                      <Link
                        href="/patient/dashboard"
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-semibold px-3 py-1.5 text-xs shadow-xs transition"
                      >
                        Go to Dashboard Overview
                        <ArrowRight className="h-3 w-3" />
                      </Link>
                      <button
                        type="button"
                        onClick={() => {
                          setSuccess("");
                          setSelectedSlot(null);
                        }}
                        className="inline-flex items-center rounded-lg border border-emerald-300 bg-white hover:bg-emerald-50 text-emerald-800 font-semibold px-3 py-1.5 text-xs transition"
                      >
                        Book Another Slot
                      </button>
                    </div>
                  </div>
                )}

                {/* Submit Action */}
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
                  className="w-full bg-teal-700 hover:bg-teal-800 text-white font-bold h-11 rounded-xl shadow-xs transition"
                >
                  {submitting ? "Confirming booking…" : "Confirm Appointment Booking"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
