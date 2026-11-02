"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Stethoscope,
  X,
  XCircle,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import {
  parsePatientAppointmentsResponseBody,
  type PatientAppointment,
} from "@/lib/appointment-response";
import { launchRazorpayCheckout } from "@/lib/razorpay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}

function formatTime(startsAt: string, endsAt: string): string {
  const start = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date(startsAt));
  const end = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date(endsAt));
  return `${start} – ${end} IST`;
}

function AppointmentStatusBadge({
  status,
  isExpired = false,
}: {
  status: PatientAppointment["status"];
  isExpired?: boolean;
}) {
  if (status === "scheduled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-800 border border-teal-200">
        <Clock className="h-3 w-3" />
        Scheduled
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 border border-emerald-200">
        <CheckCircle2 className="h-3 w-3" />
        Completed
      </span>
    );
  }
  if (status === "pending_payment") {
    if (isExpired) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600 border border-slate-200">
          <XCircle className="h-3 w-3" />
          Hold Expired
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 border border-amber-300">
        <Clock className="h-3 w-3 text-amber-600 animate-pulse" />
        Slot Reserved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 border border-slate-200">
      <XCircle className="h-3 w-3" />
      Cancelled
    </span>
  );
}

function PaymentStatusBadge({
  payment,
  appointmentStatus,
}: {
  payment?: PatientAppointment["payment"];
  appointmentStatus: PatientAppointment["status"];
}) {
  const display = payment?.statusDisplay ?? (appointmentStatus === "pending_payment" ? "Payment Pending" : "Unpaid");

  if (display === "Paid") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 border border-emerald-300">
        <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        Paid
      </span>
    );
  }

  if (display === "Refunded") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-800 border border-sky-300">
        <RotateCcw className="h-3 w-3 text-sky-600" />
        Refunded
      </span>
    );
  }

  if (display === "Partially Refunded") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-800 border border-indigo-300">
        <RotateCcw className="h-3 w-3 text-indigo-600" />
        Partially Refunded
      </span>
    );
  }

  if (display === "Refund Pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2.5 py-0.5 text-xs font-semibold text-purple-800 border border-purple-300">
        <Clock className="h-3 w-3 text-purple-600" />
        Refund Pending
      </span>
    );
  }

  if (display === "Refund Failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-800 border border-rose-300">
        <AlertCircle className="h-3 w-3 text-rose-600" />
        Refund Failed
      </span>
    );
  }

  if (display === "Payment Failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-800 border border-rose-300">
        <AlertCircle className="h-3 w-3 text-rose-600" />
        Payment Failed
      </span>
    );
  }

  if (display === "Payment Pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 border border-amber-300">
        <CreditCard className="h-3 w-3 text-amber-600 animate-pulse" />
        Payment Pending
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2.5 py-0.5 text-xs font-semibold text-slate-600 border border-slate-200">
      {display}
    </span>
  );
}

interface Slot {
  startsAt: string;
  endsAt: string;
}

export function PatientAppointments({
  refreshKey = 0,
  onCancelled,
}: {
  refreshKey?: number;
  onCancelled?: () => void;
}) {
  const [appointments, setAppointments] = useState<PatientAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [currentTime] = useState(() => Date.now());

  // Search and filter
  const [filterStatus, setFilterStatus] = useState<
    "all" | "scheduled" | "completed" | "cancelled" | "pending_payment"
  >("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Payment states
  const [payingId, setPayingId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  // Cancellation state
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Rescheduling state
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduleDoctorProfileId, setRescheduleDoctorProfileId] = useState<string>("");
  const [rescheduleDate, setRescheduleDate] = useState(() =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())
  );
  const [rescheduleSlots, setRescheduleSlots] = useState<Slot[]>([]);
  const [selectedRescheduleSlot, setSelectedRescheduleSlot] = useState<Slot | null>(null);
  const [loadingRescheduleSlots, setLoadingRescheduleSlots] = useState(false);
  const [submittingReschedule, setSubmittingReschedule] = useState(false);

  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");

  useEffect(() => {
    let active = true;
    async function loadAppointments() {
      try {
        const response = await fetch(`${backendUrl}/api/appointments/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (response.status === 401) {
          throw new Error("Your session expired. Log in again.");
        }
        if (response.status === 403) {
          throw new Error("Appointments are available to patient accounts only.");
        }
        if (!response.ok) {
          throw new Error("Could not load your appointments. Please try again.");
        }
        const text = await response.text();
        const parsed = parsePatientAppointmentsResponseBody(text);
        if (active) {
          setAppointments(parsed);
          setError("");
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Could not load your appointments.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    void loadAppointments();
    return () => {
      active = false;
    };
  }, [refreshKey, refreshTrigger]);

  // Load slots when rescheduling dialog is open and date changes
  useEffect(() => {
    if (!reschedulingId || !rescheduleDoctorProfileId || !rescheduleDate) {
      return;
    }
    let active = true;
    async function loadSlots() {
      setLoadingRescheduleSlots(true);
      setRescheduleSlots([]);
      setSelectedRescheduleSlot(null);
      try {
        const query = new URLSearchParams({
          doctorProfileId: rescheduleDoctorProfileId,
          date: rescheduleDate,
        });
        const res = await fetch(`${backendUrl}/api/appointments/availability?${query}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (res.ok) {
          const data: { slots: Slot[] } = await res.json();
          if (active) setRescheduleSlots(data.slots || []);
        }
      } catch {
        // Fallback
      } finally {
        if (active) setLoadingRescheduleSlots(false);
      }
    }
    void loadSlots();
    return () => {
      active = false;
    };
  }, [reschedulingId, rescheduleDoctorProfileId, rescheduleDate]);

  function handleManualRefresh() {
    setLoading(true);
    setRefreshTrigger((prev) => prev + 1);
  }

  async function handlePayPending(appt: PatientAppointment) {
    if (appt.holdExpiresAt && new Date(appt.holdExpiresAt).getTime() <= currentTime) {
      setActionError("This appointment hold has expired. The slot has been released.");
      handleManualRefresh();
      return;
    }

    setPayingId(appt.id);
    setActionError("");
    setActionNotice("");

    try {
      const orderRes = await fetch(`${backendUrl}/api/payments/create-order`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointmentId: appt.id }),
      });

      if (!orderRes.ok) {
        let msg = "Could not initialize payment.";
        try {
          const errData = await orderRes.json();
          if (typeof errData?.message === "string") msg = errData.message;
        } catch {}
        throw new Error(msg);
      }

      const orderData: {
        orderId: string;
        amountPaise: number;
        currency: string;
        keyId: string;
      } = await orderRes.json();

      const razorpayResponse = await launchRazorpayCheckout({
        keyId: orderData.keyId,
        orderId: orderData.orderId,
        amountPaise: orderData.amountPaise,
        currency: orderData.currency || "INR",
        name: "Medrella Healthcare",
        description: `Consultation with Dr. ${appt.doctor.name}`,
      });

      setVerifyingId(appt.id);

      const verifyRes = await fetch(`${backendUrl}/api/payments/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appointmentId: appt.id,
          razorpayOrderId: razorpayResponse.razorpay_order_id,
          razorpayPaymentId: razorpayResponse.razorpay_payment_id,
          razorpaySignature: razorpayResponse.razorpay_signature,
        }),
      });

      if (!verifyRes.ok) {
        let vMsg = "Payment verification failed.";
        try {
          const vData = await verifyRes.json();
          if (typeof vData?.message === "string") vMsg = vData.message;
        } catch {}
        throw new Error(vMsg);
      }

      setActionNotice("Payment verified! Your consultation has been successfully scheduled.");
      handleManualRefresh();
    } catch (err) {
      if (err instanceof Error && err.message === "PAYMENT_DISMISSED") {
        setActionNotice("Payment window closed. Your slot remains reserved for the remaining hold time.");
      } else {
        setActionError(err instanceof Error ? err.message : "Payment failed. Please try again.");
      }
    } finally {
      setPayingId(null);
      setVerifyingId(null);
    }
  }

  async function handleConfirmCancel(id: string) {
    setCancellingId(id);
    setActionError("");
    setActionNotice("");
    try {
      const response = await fetch(`${backendUrl}/api/appointments/${id}/cancel`, {
        method: "PATCH",
        credentials: "include",
      });
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("You are not authorized to cancel this appointment.");
      if (response.status === 404) throw new Error("Appointment not found or you do not have permission.");
      if (response.status === 409) throw new Error("This appointment is no longer scheduled or was already cancelled.");
      if (!response.ok) throw new Error("Could not cancel the appointment. Please try again.");
      setActionNotice("Appointment reservation was successfully cancelled and slot was released.");
      setConfirmingId(null);
      handleManualRefresh();
      onCancelled?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not cancel the appointment.");
    } finally {
      setCancellingId(null);
    }
  }

  async function handleConfirmReschedule(id: string) {
    if (!selectedRescheduleSlot) return;
    setSubmittingReschedule(true);
    setActionError("");
    setActionNotice("");
    try {
      const response = await fetch(`${backendUrl}/api/appointments/${id}/reschedule`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startsAt: selectedRescheduleSlot.startsAt,
          endsAt: selectedRescheduleSlot.endsAt,
        }),
      });
      if (response.status === 401) throw new Error("Your session expired. Log in again.");
      if (response.status === 403) throw new Error("You are not authorized to reschedule this appointment.");
      if (response.status === 409) throw new Error("The selected time slot is already booked or appointment cannot be rescheduled.");
      if (!response.ok) throw new Error("Could not reschedule appointment. Please choose another time slot.");
      setActionNotice("Appointment was successfully rescheduled to the new time slot.");
      setReschedulingId(null);
      setSelectedRescheduleSlot(null);
      handleManualRefresh();
      onCancelled?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to reschedule appointment.");
    } finally {
      setSubmittingReschedule(false);
    }
  }

  const filteredAppointments = useMemo(() => {
    return appointments.filter((appt) => {
      const matchesStatus = filterStatus === "all" || appt.status === filterStatus;
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        appt.doctor.name.toLowerCase().includes(q) ||
        appt.doctor.specialty.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [appointments, filterStatus, searchQuery]);

  const pendingPayments = filteredAppointments
    .filter((a) => a.status === "pending_payment" && a.holdExpiresAt && new Date(a.holdExpiresAt).getTime() > currentTime)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  const upcoming = filteredAppointments
    .filter((a) => a.status === "scheduled" && new Date(a.endsAt).getTime() >= currentTime)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  const pastAndOthers = filteredAppointments
    .filter(
      (a) =>
        (a.status !== "scheduled" && !(a.status === "pending_payment" && a.holdExpiresAt && new Date(a.holdExpiresAt).getTime() > currentTime)) ||
        (a.status === "scheduled" && new Date(a.endsAt).getTime() < currentTime)
    )
    .sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());

  return (
    <section className="space-y-6" aria-labelledby="patient-appointments-heading">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 id="patient-appointments-heading" className="text-xl font-bold text-slate-900">
            My Consultations & History
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            View upcoming visits, complete pending payments, reschedule appointment times, or inspect completed consultations.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative w-full sm:w-60">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              placeholder="Search by doctor or specialty…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 text-xs h-9 bg-white"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={loading}
            className="text-xs h-9"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={() => setFilterStatus("all")}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            filterStatus === "all"
              ? "bg-teal-700 text-white shadow-xs"
              : "bg-white border border-slate-200 text-slate-600 hover:text-slate-900"
          }`}
        >
          All ({appointments.length})
        </button>
        <button
          type="button"
          onClick={() => setFilterStatus("pending_payment")}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            filterStatus === "pending_payment"
              ? "bg-amber-600 text-white shadow-xs"
              : "bg-white border border-slate-200 text-slate-600 hover:text-slate-900"
          }`}
        >
          Pending Payment ({appointments.filter((a) => a.status === "pending_payment").length})
        </button>
        <button
          type="button"
          onClick={() => setFilterStatus("scheduled")}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            filterStatus === "scheduled"
              ? "bg-teal-700 text-white shadow-xs"
              : "bg-white border border-slate-200 text-slate-600 hover:text-slate-900"
          }`}
        >
          Scheduled ({appointments.filter((a) => a.status === "scheduled").length})
        </button>
        <button
          type="button"
          onClick={() => setFilterStatus("completed")}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            filterStatus === "completed"
              ? "bg-teal-700 text-white shadow-xs"
              : "bg-white border border-slate-200 text-slate-600 hover:text-slate-900"
          }`}
        >
          Completed ({appointments.filter((a) => a.status === "completed").length})
        </button>
        <button
          type="button"
          onClick={() => setFilterStatus("cancelled")}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            filterStatus === "cancelled"
              ? "bg-teal-700 text-white shadow-xs"
              : "bg-white border border-slate-200 text-slate-600 hover:text-slate-900"
          }`}
        >
          Cancelled ({appointments.filter((a) => a.status === "cancelled").length})
        </button>
      </div>

      {actionNotice && (
        <div role="status" className="rounded-xl bg-emerald-50 p-4 text-xs font-medium text-emerald-800 border border-emerald-200">
          {actionNotice}
        </div>
      )}

      {actionError && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-xs font-medium text-red-700 border border-red-200">
          {actionError}
        </div>
      )}

      {loading && (
        <p role="status" className="rounded-2xl border border-slate-200 bg-white p-6 text-xs text-slate-500 text-center">
          Loading your consultations…
        </p>
      )}

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs">
          <p role="alert" className="text-red-700 font-medium">{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 text-xs"
            onClick={handleManualRefresh}
          >
            Try again
          </Button>
        </div>
      )}

      {!loading && !error && appointments.length === 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center space-y-2">
          <Calendar className="h-8 w-8 text-slate-300 mx-auto" />
          <p className="text-sm font-bold text-slate-800">You have no appointments booked yet</p>
          <p className="text-xs text-slate-500">
            Select an approved specialist above to schedule your first consultation.
          </p>
        </div>
      )}

      {!loading && !error && appointments.length > 0 && (
        <div className="space-y-6">
          {/* Pending Payment Consultations */}
          {pendingPayments.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-amber-900 flex items-center gap-1.5">
                <CreditCard className="h-4 w-4 text-amber-600" /> Pending Payment & Reserved Slots ({pendingPayments.length})
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {pendingPayments.map((appt) => (
                  <AppointmentCard
                    key={appt.id}
                    appointment={appt}
                    currentTime={currentTime}
                    isPaying={payingId === appt.id}
                    isVerifying={verifyingId === appt.id}
                    isConfirming={confirmingId === appt.id}
                    isCancelling={cancellingId === appt.id}
                    onPay={() => void handlePayPending(appt)}
                    onStartCancel={() => {
                      setConfirmingId(appt.id);
                      setReschedulingId(null);
                      setActionError("");
                    }}
                    onCancelConfirm={() => void handleConfirmCancel(appt.id)}
                    onCancelDismiss={() => setConfirmingId(null)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Upcoming Consultations */}
          {upcoming.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-teal-800 flex items-center gap-1.5">
                <Clock className="h-4 w-4" /> Upcoming Consultations ({upcoming.length})
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {upcoming.map((appt) => (
                  <AppointmentCard
                    key={appt.id}
                    appointment={appt}
                    currentTime={currentTime}
                    isConfirming={confirmingId === appt.id}
                    isCancelling={cancellingId === appt.id}
                    isRescheduling={reschedulingId === appt.id}
                    rescheduleDate={rescheduleDate}
                    rescheduleSlots={rescheduleSlots}
                    selectedRescheduleSlot={selectedRescheduleSlot}
                    loadingRescheduleSlots={loadingRescheduleSlots}
                    submittingReschedule={submittingReschedule}
                    onStartCancel={() => {
                      setConfirmingId(appt.id);
                      setReschedulingId(null);
                      setActionError("");
                    }}
                    onCancelConfirm={() => void handleConfirmCancel(appt.id)}
                    onCancelDismiss={() => setConfirmingId(null)}
                    onStartReschedule={() => {
                      setReschedulingId(appt.id);
                      setConfirmingId(null);
                      setRescheduleDoctorProfileId(appt.doctor.id);
                      setSelectedRescheduleSlot(null);
                      setActionError("");
                    }}
                    onRescheduleDateChange={(d) => setRescheduleDate(d)}
                    onSelectRescheduleSlot={(s) => setSelectedRescheduleSlot(s)}
                    onRescheduleConfirm={() => void handleConfirmReschedule(appt.id)}
                    onRescheduleDismiss={() => setReschedulingId(null)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Past & Concluded Consultations */}
          {pastAndOthers.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-slate-200">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" /> Past & Concluded Consultations ({pastAndOthers.length})
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {pastAndOthers.map((appt) => (
                  <AppointmentCard
                    key={appt.id}
                    appointment={appt}
                    currentTime={currentTime}
                    isPast
                    isConfirming={confirmingId === appt.id}
                    isCancelling={cancellingId === appt.id}
                    onStartCancel={() => {
                      setConfirmingId(appt.id);
                      setReschedulingId(null);
                      setActionError("");
                    }}
                    onCancelConfirm={() => void handleConfirmCancel(appt.id)}
                    onCancelDismiss={() => setConfirmingId(null)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AppointmentCard({
  appointment,
  currentTime,
  isPast = false,
  isPaying = false,
  isVerifying = false,
  isConfirming = false,
  isCancelling = false,
  isRescheduling = false,
  rescheduleDate = "",
  rescheduleSlots = [],
  selectedRescheduleSlot = null,
  loadingRescheduleSlots = false,
  submittingReschedule = false,
  onPay,
  onStartCancel,
  onCancelConfirm,
  onCancelDismiss,
  onStartReschedule,
  onRescheduleDateChange,
  onSelectRescheduleSlot,
  onRescheduleConfirm,
  onRescheduleDismiss,
}: {
  appointment: PatientAppointment;
  currentTime: number;
  isPast?: boolean;
  isPaying?: boolean;
  isVerifying?: boolean;
  isConfirming?: boolean;
  isCancelling?: boolean;
  isRescheduling?: boolean;
  rescheduleDate?: string;
  rescheduleSlots?: Slot[];
  selectedRescheduleSlot?: Slot | null;
  loadingRescheduleSlots?: boolean;
  submittingReschedule?: boolean;
  onPay?: () => void;
  onStartCancel?: () => void;
  onCancelConfirm?: () => void;
  onCancelDismiss?: () => void;
  onStartReschedule?: () => void;
  onRescheduleDateChange?: (date: string) => void;
  onSelectRescheduleSlot?: (slot: Slot) => void;
  onRescheduleConfirm?: () => void;
  onRescheduleDismiss?: () => void;
}) {
  const isPending = appointment.status === "pending_payment";
  const isExpired = isPending && (!appointment.holdExpiresAt || new Date(appointment.holdExpiresAt).getTime() <= currentTime);
  const isHoldActive = isPending && appointment.holdExpiresAt != null && new Date(appointment.holdExpiresAt).getTime() > currentTime;

  return (
    <div
      className={`rounded-2xl border p-5 transition ${
        isHoldActive
          ? "border-amber-300 bg-amber-50/40 shadow-xs"
          : isPast
          ? "border-slate-200 bg-slate-50/60"
          : "border-slate-200 bg-white hover:border-teal-400 shadow-xs"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-800 font-bold border border-teal-200">
            <Stethoscope className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-900">{appointment.doctor.name}</p>
            <p className="text-xs font-semibold text-teal-700">{appointment.doctor.specialty}</p>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 items-end">
          <AppointmentStatusBadge status={appointment.status} isExpired={isExpired} />
          <PaymentStatusBadge payment={appointment.payment} appointmentStatus={appointment.status} />
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-xs">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Date</dt>
          <dd className="mt-0.5 font-semibold text-slate-800">{formatDate(appointment.startsAt)}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Time</dt>
          <dd className="mt-0.5 font-semibold text-slate-800">
            {formatTime(appointment.startsAt, appointment.endsAt)}
          </dd>
        </div>
      </dl>

      {/* Payment Details Section */}
      {appointment.payment && (
        <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200/80 p-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between text-slate-700">
            <span className="text-[11px] font-semibold text-slate-500">Amount:</span>
            <span className="font-bold text-slate-900">
              ₹{(appointment.payment.amountPaise / 100).toFixed(2)}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-700">
            <span className="text-[11px] font-semibold text-slate-500">Payment Method:</span>
            <span className="text-slate-800 font-medium">
              {appointment.payment.method ?? "Razorpay Online"}
            </span>
          </div>
          {appointment.payment.razorpayPaymentId && (
            <div className="flex items-center justify-between text-slate-700">
              <span className="text-[11px] font-semibold text-slate-500">Payment ID:</span>
              <span className="font-mono text-[11px] text-slate-600 select-all">
                {appointment.payment.razorpayPaymentId}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Dedicated Refund Status Box for Cancelled Appointments */}
      {appointment.status === "cancelled" && appointment.payment && (
        <div className="mt-3 rounded-xl bg-sky-50/70 border border-sky-200 p-3 space-y-1.5 text-xs">
          <div className="flex items-center gap-1.5 text-sky-950 font-bold">
            <RotateCcw className="h-3.5 w-3.5 text-sky-700" />
            <span>Refund Details</span>
          </div>
          <div className="flex items-center justify-between text-sky-900">
            <span className="text-[11px] font-semibold text-sky-700">Refund Status:</span>
            <span className="font-bold">
              {appointment.payment.refund?.status === "processed" || appointment.payment.statusDisplay === "Refunded"
                ? "Refund Processed"
                : appointment.payment.refund?.status === "pending" || appointment.payment.statusDisplay === "Refund Pending"
                ? "Refund Pending (Awaiting Bank Settlement)"
                : appointment.payment.refund?.status === "failed" || appointment.payment.statusDisplay === "Refund Failed"
                ? "Refund Failed"
                : appointment.payment.statusDisplay}
            </span>
          </div>
          <div className="flex items-center justify-between text-sky-900">
            <span className="text-[11px] font-semibold text-sky-700">Refund Amount:</span>
            <span className="font-bold text-emerald-700">
              ₹{((appointment.payment.refund?.amountPaise ?? appointment.payment.refundedAmountPaise ?? appointment.payment.amountPaise) / 100).toFixed(2)}
            </span>
          </div>
          {appointment.payment.refund?.arn && (
            <div className="flex items-center justify-between text-sky-900">
              <span className="text-[11px] font-semibold text-sky-700">Bank Reference (ARN):</span>
              <span className="font-mono text-[11px] font-semibold text-slate-800 select-all">
                {appointment.payment.refund.arn}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Pending Payment Card Actions */}
      {!isPast && isPending && (
        <div className="mt-4 border-t border-slate-100 pt-3 space-y-3">
          {isConfirming && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 space-y-2">
              <p className="text-xs font-bold text-red-900">Cancel this slot reservation?</p>
              <p className="text-[11px] text-red-700">
                This will release the reserved time slot for other patients.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs bg-red-600 text-white hover:bg-red-700"
                  disabled={isCancelling}
                  onClick={onCancelConfirm}
                >
                  {isCancelling ? "Releasing…" : "Yes, release hold"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-slate-300"
                  disabled={isCancelling}
                  onClick={onCancelDismiss}
                >
                  Keep
                </Button>
              </div>
            </div>
          )}

          {!isConfirming && (
            <div className="space-y-2">
              {isHoldActive ? (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-amber-800 flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5 text-amber-600 animate-pulse" />
                    10-Minute Hold Active
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 text-xs bg-teal-700 hover:bg-teal-800 text-white font-bold"
                      disabled={isPaying || isVerifying}
                      onClick={onPay}
                    >
                      {isVerifying ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Verifying…
                        </>
                      ) : isPaying ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Launching…
                        </>
                      ) : (
                        <>
                          <CreditCard className="h-3.5 w-3.5 mr-1.5" /> Pay Now
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={onStartCancel}
                    >
                      Cancel Hold
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500">Hold has expired. Slot was released.</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs border-slate-200 text-slate-600 hover:bg-slate-50"
                    onClick={onStartCancel}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Scheduled Appointment Actions */}
      {!isPast && appointment.status === "scheduled" && (
        <div className="mt-4 border-t border-slate-100 pt-3 space-y-3">
          {/* Reschedule View */}
          {isRescheduling && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-blue-950 flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5 text-blue-700" /> Reschedule Consultation
                </p>
                <button
                  type="button"
                  onClick={onRescheduleDismiss}
                  className="text-xs text-slate-400 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Select New Date
                </label>
                <Input
                  type="date"
                  min={new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}
                  value={rescheduleDate}
                  onChange={(e) => onRescheduleDateChange?.(e.target.value)}
                  className="text-xs bg-white h-8"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Available Slots
                </label>
                {loadingRescheduleSlots && (
                  <p className="text-[11px] text-slate-500">Querying open slots…</p>
                )}
                {!loadingRescheduleSlots && rescheduleSlots.length === 0 && (
                  <p className="text-[11px] text-slate-500">
                    No open slots on this date. Please pick another weekday.
                  </p>
                )}
                {!loadingRescheduleSlots && rescheduleSlots.length > 0 && (
                  <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto">
                    {rescheduleSlots.map((slot) => {
                      const selected = selectedRescheduleSlot?.startsAt === slot.startsAt;
                      const timeStr = formatTime(slot.startsAt, slot.endsAt);
                      return (
                        <button
                          key={slot.startsAt}
                          type="button"
                          onClick={() => onSelectRescheduleSlot?.(slot)}
                          className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition ${
                            selected
                              ? "bg-blue-700 text-white"
                              : "bg-white border border-slate-200 text-slate-700 hover:border-blue-400"
                          }`}
                        >
                          {timeStr}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-blue-200">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs bg-blue-700 text-white hover:bg-blue-800"
                  disabled={submittingReschedule || !selectedRescheduleSlot}
                  onClick={onRescheduleConfirm}
                >
                  {submittingReschedule ? "Rescheduling…" : "Confirm Reschedule"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={onRescheduleDismiss}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Cancellation Confirmation View */}
          {isConfirming && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 space-y-2">
              <p className="text-xs font-bold text-red-900">Cancel this appointment?</p>
              <p className="text-[11px] text-red-700">
                This will release the reserved time slot for other patients.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs bg-red-600 text-white hover:bg-red-700"
                  disabled={isCancelling}
                  onClick={onCancelConfirm}
                >
                  {isCancelling ? "Cancelling…" : "Yes, cancel"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-slate-300"
                  disabled={isCancelling}
                  onClick={onCancelDismiss}
                >
                  Keep
                </Button>
              </div>
            </div>
          )}

          {/* Default Actions */}
          {!isConfirming && !isRescheduling && (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs border-blue-200 text-blue-700 hover:bg-blue-50 font-semibold"
                onClick={onStartReschedule}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Reschedule
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={onStartCancel}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
