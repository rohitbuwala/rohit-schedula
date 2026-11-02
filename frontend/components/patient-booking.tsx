"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { z } from "zod";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Calendar,
  CalendarCheck,
  CheckCircle2,
  Clock,
  CreditCard,
  GraduationCap,
  HeartPulse,
  Info,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Timer,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import { appointmentFormSchema } from "@/lib/appointment-validation";
import { launchRazorpayCheckout } from "@/lib/razorpay";
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

type PaymentStep =
  | "idle"
  | "creating_hold"
  | "creating_order"
  | "checkout_open"
  | "verifying"
  | "success"
  | "dismissed"
  | "failed"
  | "expired";

interface ActiveHold {
  appointmentId: string;
  doctorProfileId: string;
  doctorName: string;
  specialty: string;
  startsAt: string;
  endsAt: string;
  holdExpiresAt: string;
  consultationFeeInr: number;
}

interface BookingConfirmed {
  appointmentId: string;
  paymentId: string;
  doctorName: string;
  specialty: string;
  startsAt: string;
  endsAt: string;
  amountPaise: number;
}

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [refreshKey, setRefreshKey] = useState(0);

  // Active Hold & Payment states
  const [activeHold, setActiveHold] = useState<ActiveHold | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);
  const [paymentStep, setPaymentStep] = useState<PaymentStep>("idle");
  const [paymentError, setPaymentError] = useState("");
  const [bookingConfirmed, setBookingConfirmed] = useState<BookingConfirmed | null>(null);
  const [cancellingHold, setCancellingHold] = useState(false);

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

  // Active Hold Countdown Timer (10 minutes)
  useEffect(() => {
    if (!activeHold) return;

    const checkExpiry = () => {
      const remainingMs = new Date(activeHold.holdExpiresAt).getTime() - Date.now();
      const diffSec = Math.max(0, Math.floor(remainingMs / 1000));
      setSecondsRemaining(diffSec);

      if (diffSec <= 0) {
        setActiveHold(null);
        setPaymentStep("expired");
        setError("Your 10-minute appointment slot hold has expired. The slot has been released. Please select a time slot to try again.");
        setSelectedSlot(null);
        setRefreshKey((v) => v + 1);
      }
    };

    checkExpiry();
    const timer = setInterval(checkExpiry, 1000);
    return () => clearInterval(timer);
  }, [activeHold]);

  function formatCountdown(totalSec: number) {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  async function triggerPayment(hold: ActiveHold) {
    if (paymentStep === "checkout_open" || paymentStep === "verifying") return;

    if (new Date(hold.holdExpiresAt).getTime() <= currentTime) {
      setActiveHold(null);
      setPaymentStep("expired");
      setError("This appointment hold has expired. Please select a new slot.");
      setRefreshKey((k) => k + 1);
      return;
    }

    setPaymentStep("creating_order");
    setPaymentError("");

    try {
      const orderRes = await fetch(`${backendUrl}/api/payments/create-order`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointmentId: hold.appointmentId }),
      });

      if (!orderRes.ok) {
        let msg = "Could not create payment order.";
        try {
          const errData = await orderRes.json();
          if (typeof errData?.message === "string") msg = errData.message;
        } catch {}

        if (orderRes.status === 400 && msg.toLowerCase().includes("expired")) {
          setActiveHold(null);
          setPaymentStep("expired");
          setError("Your appointment hold has expired. The slot has been released.");
          setRefreshKey((k) => k + 1);
          return;
        }

        setPaymentStep("failed");
        setPaymentError(msg);
        return;
      }

      const orderData: {
        orderId: string;
        amountPaise: number;
        currency: string;
        keyId: string;
        appointmentId: string;
      } = await orderRes.json();

      setPaymentStep("checkout_open");

      try {
        const razorpayResponse = await launchRazorpayCheckout({
          keyId: orderData.keyId,
          orderId: orderData.orderId,
          amountPaise: orderData.amountPaise,
          currency: orderData.currency || "INR",
          name: "Medrella Healthcare",
          description: `Consultation with ${hold.doctorName}`,
          prefill: {
            name: name || undefined,
          },
          onDismiss: () => {
            setPaymentStep("dismissed");
          },
          onError: (err) => {
            console.error("Razorpay modal error:", err);
          },
        });

        // Backend Cryptographic Verification
        setPaymentStep("verifying");
        const verifyRes = await fetch(`${backendUrl}/api/payments/verify`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appointmentId: hold.appointmentId,
            razorpayOrderId: razorpayResponse.razorpay_order_id,
            razorpayPaymentId: razorpayResponse.razorpay_payment_id,
            razorpaySignature: razorpayResponse.razorpay_signature,
          }),
        });

        if (!verifyRes.ok) {
          let verifyMsg = "Payment verification failed.";
          try {
            const vData = await verifyRes.json();
            if (typeof vData?.message === "string") verifyMsg = vData.message;
          } catch {}
          setPaymentStep("failed");
          setPaymentError(
            `${verifyMsg} If your bank account was debited, our team will confirm your consultation automatically or process a refund.`
          );
          return;
        }

        const verifyResult: {
          success: boolean;
          paymentId?: string;
        } = await verifyRes.json();

        setActiveHold(null);
        setPaymentStep("success");
        setBookingConfirmed({
          appointmentId: hold.appointmentId,
          paymentId: verifyResult.paymentId || razorpayResponse.razorpay_payment_id,
          doctorName: hold.doctorName,
          specialty: hold.specialty,
          startsAt: hold.startsAt,
          endsAt: hold.endsAt,
          amountPaise: orderData.amountPaise,
        });
        setSelectedSlot(null);
        setRefreshKey((k) => k + 1);
      } catch (checkoutErr) {
        if (checkoutErr instanceof Error && checkoutErr.message === "PAYMENT_DISMISSED") {
          setPaymentStep("dismissed");
        } else {
          setPaymentStep("failed");
          setPaymentError(
            checkoutErr instanceof Error
              ? checkoutErr.message
              : "Payment could not be completed. You can retry with your remaining slot hold."
          );
        }
      }
    } catch (orderErr) {
      setPaymentStep("failed");
      setPaymentError(orderErr instanceof Error ? orderErr.message : "Network error creating payment order.");
    }
  }

  async function handleCancelHold() {
    if (!activeHold) return;
    setCancellingHold(true);
    try {
      await fetch(`${backendUrl}/api/appointments/${activeHold.appointmentId}/cancel`, {
        method: "PATCH",
        credentials: "include",
      });
      setActiveHold(null);
      setPaymentStep("idle");
      setPaymentError("");
      setSelectedSlot(null);
      setRefreshKey((v) => v + 1);
    } catch {
      setActiveHold(null);
      setPaymentStep("idle");
      setRefreshKey((v) => v + 1);
    } finally {
      setCancellingHold(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPaymentError("");
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
    setPaymentStep("creating_hold");

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
          throw new Error(serverMessage || "The selected time slot is already booked or on hold. Please choose another slot.");
        }
        throw new Error(
          serverMessage || (response.status === 400 ? "Check the selected date and time." : "Booking failed. Please try again.")
        );
      }

      const result: {
        id: string;
        startsAt: string;
        endsAt: string;
        status: string;
        holdExpiresAt: string;
      } = await response.json();

      const newHold: ActiveHold = {
        appointmentId: result.id,
        doctorProfileId: selectedDoctor,
        doctorName: selectedDoctorData?.name || "Doctor",
        specialty: selectedDoctorData?.specialty || "General Medicine",
        startsAt: result.startsAt,
        endsAt: result.endsAt,
        holdExpiresAt: result.holdExpiresAt,
        consultationFeeInr: selectedDoctorData?.consultationFeeInr ?? 500,
      };

      setActiveHold(newHold);
      // Immediately trigger payment
      void triggerPayment(newHold);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Booking failed. Please try again.");
      setPaymentStep("idle");
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

  function formatConfirmedDate(startsAt: string) {
    return new Intl.DateTimeFormat("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    }).format(new Date(startsAt));
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
              {name ? `Welcome, ${name}. ` : ""}Select an approved physician, inspect verified credentials, and complete payment with instant 10-minute slot reservation.
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

      {/* Booking Confirmed Full Banner Screen */}
      {bookingConfirmed && (
        <Card className="border-emerald-300 bg-gradient-to-br from-emerald-50/80 via-white to-teal-50/60 shadow-md overflow-hidden">
          <CardHeader className="border-b border-emerald-100 bg-emerald-100/40 pb-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-xs">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <CardTitle className="text-lg font-bold text-emerald-950">
                  Consultation Confirmed & Payment Verified!
                </CardTitle>
                <CardDescription className="text-xs text-emerald-800">
                  Your payment has been securely captured by Razorpay and your time slot is officially scheduled.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="rounded-xl border border-emerald-200 bg-white p-4 space-y-2">
                <p className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                  Consultation Summary
                </p>
                <div className="flex justify-between border-b border-slate-100 pb-1.5">
                  <span className="text-slate-500">Physician:</span>
                  <span className="font-bold text-slate-900">{bookingConfirmed.doctorName}</span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-1.5">
                  <span className="text-slate-500">Specialty:</span>
                  <span className="font-semibold text-teal-700">{bookingConfirmed.specialty}</span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-1.5">
                  <span className="text-slate-500">Date:</span>
                  <span className="font-semibold text-slate-900">{formatConfirmedDate(bookingConfirmed.startsAt)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Time Window:</span>
                  <span className="font-semibold text-teal-800">
                    {formatSlotDisplay(bookingConfirmed.startsAt, bookingConfirmed.endsAt)}
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-emerald-200 bg-white p-4 space-y-2">
                <p className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                  Transaction & Receipt
                </p>
                <div className="flex justify-between border-b border-slate-100 pb-1.5">
                  <span className="text-slate-500">Appointment ID:</span>
                  <span className="font-mono text-[11px] text-slate-800 font-semibold truncate max-w-[200px]">
                    {bookingConfirmed.appointmentId}
                  </span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-1.5">
                  <span className="text-slate-500">Payment ID:</span>
                  <span className="font-mono text-[11px] text-emerald-800 font-bold truncate max-w-[200px]">
                    {bookingConfirmed.paymentId}
                  </span>
                </div>
                <div className="flex justify-between border-b border-slate-100 pb-1.5">
                  <span className="text-slate-500">Amount Paid:</span>
                  <span className="font-bold text-slate-900 text-sm">
                    ₹{(bookingConfirmed.amountPaise / 100).toLocaleString("en-IN")}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Status:</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-900">
                    <ShieldCheck className="h-3 w-3" /> Captured & Confirmed
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Link
                href="/patient/dashboard"
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold px-4 py-2 text-xs shadow-xs transition"
              >
                View in My Consultations
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setBookingConfirmed(null);
                  setSelectedSlot(null);
                  setError("");
                  setPaymentError("");
                }}
                className="text-xs"
              >
                Schedule Another Consultation
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Two-Column Layout */}
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
                    if (activeHold) return; // Prevent changing doctor during active hold
                    setSelectedDoctor(doctor.id);
                    setError("");
                    setPaymentError("");
                    setFieldErrors({});
                  }}
                  className={`rounded-2xl text-left transition cursor-pointer border ${
                    isSelected
                      ? "ring-2 ring-teal-700 border-teal-700 bg-teal-50/30 shadow-md scale-[1.01]"
                      : "border-slate-200 bg-white hover:border-teal-300 hover:shadow-xs"
                  } ${activeHold ? "opacity-60 pointer-events-none" : ""}`}
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

        {/* Right Column: Scheduling & Payment (5 Cols) */}
        <section aria-labelledby="schedule-heading" className="lg:col-span-5 space-y-5 lg:sticky lg:top-24">
          {/* Active Hold Status Card */}
          {activeHold && (
            <Card className="border-amber-300 bg-gradient-to-br from-amber-50/90 to-orange-50/40 shadow-md relative overflow-hidden animate-in fade-in-50">
              <div className="absolute top-0 right-0 h-20 w-20 bg-amber-200/40 rounded-bl-full pointer-events-none" />
              <CardHeader className="pb-3 border-b border-amber-200/70">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Timer className="h-5 w-5 text-amber-700 animate-pulse" />
                    <CardTitle className="text-sm font-bold text-amber-950">
                      10-Minute Slot Hold Active
                    </CardTitle>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-200 px-2.5 py-0.5 text-xs font-bold text-amber-900 border border-amber-300">
                    <Clock className="h-3.5 w-3.5" />
                    {formatCountdown(secondsRemaining)}
                  </span>
                </div>
                <CardDescription className="text-xs text-amber-800">
                  This consultation slot is exclusively reserved for you. Complete payment before the timer expires.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-4 text-xs">
                <div className="rounded-xl border border-amber-200 bg-white/80 p-3 space-y-1">
                  <p className="font-semibold text-slate-900">Dr. {activeHold.doctorName}</p>
                  <p className="text-teal-700 font-medium">{activeHold.specialty}</p>
                  <p className="text-slate-600">
                    {formatSlotDisplay(activeHold.startsAt, activeHold.endsAt)}
                  </p>
                  <div className="flex justify-between border-t border-slate-100 pt-1.5 font-bold">
                    <span>Consultation Fee:</span>
                    <span className="text-teal-900">₹{activeHold.consultationFeeInr}</span>
                  </div>
                </div>

                {/* Payment Progress Indicators */}
                {paymentStep === "checkout_open" && (
                  <div className="rounded-xl bg-teal-50 border border-teal-200 p-3 text-teal-900 flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-teal-700 shrink-0" />
                    <span>Razorpay checkout window is open. Complete payment in the popup.</span>
                  </div>
                )}

                {paymentStep === "verifying" && (
                  <div className="rounded-xl bg-teal-50 border border-teal-200 p-3 text-teal-900 flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-teal-700 shrink-0" />
                    <span className="font-semibold">
                      Cryptographically verifying payment with bank… Please wait.
                    </span>
                  </div>
                )}

                {paymentStep === "dismissed" && (
                  <div className="rounded-xl bg-amber-100/70 border border-amber-300 p-3 text-amber-900 flex items-start gap-2">
                    <Info className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">Checkout window was closed</p>
                      <p className="text-[11px] mt-0.5">
                        Your slot is still reserved. Click &quot;Complete Payment&quot; below to finish booking.
                      </p>
                    </div>
                  </div>
                )}

                {paymentError && (
                  <div role="alert" className="rounded-xl bg-red-50 border border-red-200 p-3 text-red-700 flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                    <p className="text-[11px] leading-relaxed">{paymentError}</p>
                  </div>
                )}

                {/* Actions */}
                <div className="space-y-2 pt-1">
                  <Button
                    type="button"
                    onClick={() => void triggerPayment(activeHold)}
                    disabled={
                      paymentStep === "checkout_open" ||
                      paymentStep === "verifying" ||
                      secondsRemaining <= 0
                    }
                    className="w-full bg-teal-700 hover:bg-teal-800 text-white font-bold h-10 rounded-xl shadow-xs transition"
                  >
                    {paymentStep === "verifying" ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verifying…
                      </>
                    ) : (
                      <>
                        <CreditCard className="h-4 w-4 mr-2" /> Complete Payment (₹{activeHold.consultationFeeInr})
                      </>
                    )}
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleCancelHold()}
                    disabled={cancellingHold || paymentStep === "verifying"}
                    className="w-full text-xs text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700 h-9"
                  >
                    {cancellingHold ? "Releasing slot…" : "Release Slot / Cancel Reservation"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Regular Booking Form Card */}
          <Card className={`border-slate-200 bg-white shadow-sm overflow-hidden ${activeHold ? "opacity-50 pointer-events-none" : ""}`}>
            <CardHeader className="bg-gradient-to-r from-teal-50/50 to-white border-b border-slate-100 pb-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-teal-700" />
                <CardTitle id="schedule-heading" className="text-base font-bold text-slate-900">
                  Step 2 & 3: Select Date & Slot
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
                      setError("");
                      setPaymentError("");
                    }}
                    disabled={!selectedDoctor || loadingDoctors || Boolean(loadError) || Boolean(activeHold)}
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
                  <fieldset disabled={loadingSlots || Boolean(activeHold)} className="space-y-2">
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
                              setPaymentError("");
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
                    <p className="font-semibold">Unable to proceed</p>
                    <p className="mt-0.5">{error}</p>
                  </div>
                )}

                {/* Submit Action */}
                <Button
                  type="submit"
                  disabled={
                    submitting ||
                    paymentStep === "creating_hold" ||
                    paymentStep === "creating_order" ||
                    paymentStep === "checkout_open" ||
                    paymentStep === "verifying" ||
                    loadingDoctors ||
                    loadingSlots ||
                    Boolean(loadError) ||
                    Boolean(slotError) ||
                    !selectedDoctor ||
                    !selectedSlot ||
                    Boolean(activeHold)
                  }
                  className="w-full bg-teal-700 hover:bg-teal-800 text-white font-bold h-11 rounded-xl shadow-xs transition"
                >
                  {submitting || paymentStep === "creating_hold" ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Reserving 10-Minute Hold…
                    </>
                  ) : (
                    <>
                      <CreditCard className="h-4 w-4 mr-2" /> Proceed to Payment (₹{selectedDoctorData?.consultationFeeInr?.toLocaleString("en-IN") ?? 500})
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
