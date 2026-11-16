"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { launchRazorpayCheckout } from "@/lib/razorpay";
import { payForAssistantHold } from "./assistant-payment";
import { hasUnfinishedBookingDraft } from "./assistant-booking-draft";
import { CHAT_RETENTION_MS, MAX_HISTORY_TURNS, chatHistoryKey, readChatHistory, saveChatHistory } from "./assistant-history";
import { assistantResponseSchema } from "@/lib/assistant-api";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AudioLines, Calendar, Clock, LoaderCircle, Mic, MoveDiagonal, Send, Sparkles, Square, Stethoscope, Volume2, X } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AssistantApiError, assistantMessageSchema, sendAssistantMessage, synthesizeAssistantAudio, transcribeAssistantAudio, type AssistantResponse } from "@/lib/assistant-api";
import { AssistantResult } from "./assistant-result";
import { SafeMarkdown } from "./safe-markdown";
import { formatSlotRange, slotDurationLabel, groupSlotsByPeriod } from "./assistant-ui-helpers";
import { appendSpeechTranscript, speechErrorMessage } from "./assistant-speech";
import { startAssistantWavRecorder } from "./assistant-wav-recorder";
import { createAssistantVoiceSession, handoffAssistantRecorder, startAssistantVoiceWhenReady } from "./assistant-voice-session";
import { playAssistantAudio } from "./assistant-audio-playback";
import { createBargeDetector } from "./assistant-barge-detector";
import { useAssistantWindow } from "./use-assistant-window";
import { bookingReviewUrl } from "@/lib/appointment-validation";
import { bookingStorageKey, clearBookingAttempt, createBookingHold, emptyBookingDraft, matchDoctor, matchSlot, parseBookingDate, readBookingAttempt, saveBookingAttempt, type BookingAttempt, type BookingDoctor, type BookingSlot, type HoldResult } from "./assistant-booking-draft";

const bookingDoctorsSchema = z.array(z.object({ id: z.uuid(), name: z.string(), specialty: z.string(), consultationFeeInr: z.number().nonnegative().nullable() }));
const bookingAvailabilitySchema = z.object({ doctorProfileId: z.uuid(), date: z.iso.date(), timezone: z.string(), slots: z.array(z.object({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }) })) });

const starters = {
  patient: [
    { label: "My appointments", message: "Show my appointments" },
    { label: "My prescriptions", message: "Show my prescriptions" },
    { label: "My payment history", message: "Show my payment history" },
    { label: "Cancellable appointments", message: "Show cancellable appointments" },
    { label: "Reschedulable appointments", message: "Show reschedulable appointments" },
    { label: "Find a cardiologist", message: "Find a cardiologist" },
    { label: "Check availability", message: "Check availability with ", draft: true },
  ],
  doctor: [
    { label: "Today’s appointments", message: "Show today's appointments" },
    { label: "Tomorrow's appointments", message: "Show tomorrow's appointments" },
    { label: "Today's statistics", message: "Show appointment statistics for today" },
    { label: "Next available slot", message: "Find my next available slot" },
    { label: "Check conflicts", message: "Check schedule conflicts from ", draft: true },
    { label: "My schedule", message: "Show my schedule" },
  ],
} as const;

type Turn = { message: string; createdAt?: number; result?: AssistantResponse };

const floatingPosition = "fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-[35] sm:bottom-[max(1.5rem,env(safe-area-inset-bottom))] sm:right-[max(1.5rem,env(safe-area-inset-right))]";

function getRelativeDateStr(offsetDays: number, timezone: string): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const tz = timezone === "IST" ? "Asia/Kolkata" : timezone;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function AssistantPanel({ role, patientId }: { role: "patient" | "doctor"; patientId?: string }) {
  const router = useRouter();
  const paymentInFlight = useRef(false);
  const [paymentStage, setPaymentStage] = useState<"starting" | "opening" | "verifying" | null>(null);
  const [paymentNotice, setPaymentNotice] = useState("");
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const active = useRef<AbortController | null>(null);
  const speech = useRef<ReturnType<typeof createAssistantVoiceSession>>(null);
  const voiceCleanup = useRef<Promise<void> | null>(null);
  const monitor = useRef<{ controller: AbortController; done: Promise<void> } | null>(null);
  const barge = useRef(false);
  const [bargeEnabled, setBargeEnabled] = useState(false);
  const playback = useRef<ReturnType<typeof playAssistantAudio>>(null);
  const playbackAbort = useRef<AbortController | null>(null);
  const playbackRequest = useRef(0);
  const log = useRef<HTMLOListElement>(null);
  const continuous = useRef(false);
  const generation = useRef(0);
  const turnCount = useRef(0);
  const bookingRequest = useRef(0);
  const bookingAttempt = useRef<BookingAttempt | null>(null);
  const bookingConfirming = useRef(false);
  const bookingMounted = useRef(true);
  const bookingStorageReady = useRef(role !== "patient");
  const bookingStorageBlocked = useRef(false);
  const [bookingHold, setBookingHold] = useState<HoldResult | null>(null);
  const [bookingLocked, setBookingLocked] = useState(false);
  const [bookingDiscardable, setBookingDiscardable] = useState(false);
  const [bookingActive, setBookingActive] = useState(false);
  const [booking, setBooking] = useState(emptyBookingDraft);
  const [bookingDoctors, setBookingDoctors] = useState<BookingDoctor[]>([]);
  const [bookingSlots, setBookingSlots] = useState<BookingSlot[]>([]);
  const [bookingNotice, setBookingNotice] = useState("");
  const [bookingLoading, setBookingLoading] = useState(false);
  const [continuousEnabled, setContinuousEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const chatWindow = useAssistantWindow(open, panel);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AssistantApiError | null>(null);
  const [voiceState, setVoiceState] = useState<"starting" | "listening" | "stopping" | "transcribing" | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const [playbackIndex, setPlaybackIndex] = useState<number | null>(null);
  const [playbackStarting, setPlaybackStarting] = useState(false);
  const [playbackLanguage, setPlaybackLanguage] = useState<"en" | "hi">("en");
  const [playbackNotice, setPlaybackNotice] = useState("");
  const blocked = error?.status === 401 || error?.status === 403;
  const draftHint = draft.startsWith("Check availability with ")
    ? "Enter a doctor and date (YYYY-MM-DD). Add a time (HH:mm) to check a specific slot."
    : draft.startsWith("Check schedule conflicts from ")
      ? "Enter a start and end with timezones, such as 2026-11-12T09:00+05:30 to 2026-11-12T10:00+05:30."
      : null;

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      let saved: Turn[] = [];
      if (role === "patient" && patientId) {
        try {
          saved = readChatHistory(window.localStorage, patientId, assistantResponseSchema);
          if (!window.localStorage.getItem(chatHistoryKey(patientId))) {
            const previous = readChatHistory(window.sessionStorage, patientId, assistantResponseSchema);
            if (previous.length) {
              saveChatHistory(window.localStorage, patientId, previous);
              if (window.localStorage.getItem(chatHistoryKey(patientId))) {
                saved = previous;
                window.sessionStorage.removeItem(chatHistoryKey(patientId));
              }
            }
          }
        } catch {}
      }
      setTurns(saved);
      turnCount.current = saved.length;
      setHistoryReady(true);
    });
    return () => { mounted = false; };
  }, [role, patientId]);

  useEffect(() => {
    if (!historyReady || role !== "patient" || !patientId) return;
    try { saveChatHistory(window.localStorage, patientId, turns); } catch {}
  }, [historyReady, role, patientId, turns]);

  useEffect(() => {
    const timer = setInterval(() => {
      setTurns((previous) => {
        const recent = previous.filter((turn) => turn.createdAt === undefined || Date.now() - turn.createdAt < CHAT_RETENTION_MS);
        return recent.length === previous.length ? previous : recent;
      });
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  function clearChat() {
    if (active.current) return;
    disableContinuous(); abortVoiceInput(); stopPlayback();
    setTurns([]); turnCount.current = 0; setError(null);
    if (patientId) try { window.localStorage.removeItem(chatHistoryKey(patientId)); } catch {}
  }

  useEffect(() => {
    bookingMounted.current = true;
    return () => {
    bookingMounted.current = false;
    continuous.current = false;
    bookingRequest.current += 1;
    generation.current += 1;
    playbackRequest.current += 1;
    active.current?.abort();
    active.current = null;
    speech.current?.cancel();
    speech.current = null;
    monitor.current?.controller.abort();
    monitor.current = null;
    playbackAbort.current?.abort();
    playbackAbort.current = null;
    playback.current?.stop();
    playback.current = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      const target = input.current?.disabled ? closeButton.current : input.current;
      target?.focus({ preventScroll: true });
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      launcher.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (log.current?.parentElement) log.current.parentElement.scrollTop = log.current.parentElement.scrollHeight;
  }, [turns, open]);

  function restoreBookingAttempt(attempt: BookingAttempt) {
    bookingAttempt.current = attempt;
    const zone = "Asia/Kolkata";
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(attempt.payload.startsAt));
    setBooking({ doctor: { id: attempt.payload.doctorProfileId, name: `Doctor ${attempt.payload.doctorProfileId}`, specialty: "Review previous selection", consultationFeeInr: null },
      date, timezone: zone, fee: null, slot: { startsAt: attempt.payload.startsAt, endsAt: attempt.payload.endsAt } });
    setBookingLocked(true); setBookingActive(true); setBookingNotice("A previous booking attempt needs recovery. Review the time and retry the same request, or check your appointments.");
  }

  useEffect(() => {
    if (role !== "patient") return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        if (!patientId) throw new Error("Missing patient identity");
        const stored = readBookingAttempt(window.localStorage, patientId);
        if (stored.kind === "found") { restoreBookingAttempt(stored.attempt); setOpen(true); }
        else if (stored.kind !== "missing") { bookingStorageBlocked.current = true; setBookingNotice("A saved booking attempt could not be read. Check your appointments before booking again."); }
      } catch { bookingStorageBlocked.current = true; }
      bookingStorageReady.current = true;
    });
    return () => { active = false; };
  }, [role, patientId]);

  async function submit(message: string, voiceTurn?: number) {
    const parsed = assistantMessageSchema.safeParse(message);
    if (!historyReady || active.current || blocked || !parsed.success) return;
    if (hasUnfinishedBookingDraft(bookingActive, bookingHold, parsed.data)) {
      if (continuous.current) disableContinuous();
      abortVoiceInput();
      setDraft("");
      handleBookingText(parsed.data);
      return;
    }
    if (voiceTurn === undefined && continuous.current) disableContinuous();
    abortVoiceInput();
    setVoiceError("");
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    if (voiceTurn === undefined) setDraft("");
    const index = Math.min(turnCount.current, MAX_HISTORY_TURNS - 1);
    // eslint-disable-next-line react-hooks/purity -- submit runs on a user message or transcription completion, never during render.
    const createdAt = Date.now();
    turnCount.current = index + 1;
    setTurns((previous) => [...previous.slice(-(MAX_HISTORY_TURNS - 1)), { message: parsed.data, createdAt }]);
    try {
      const result = await sendAssistantMessage(parsed.data, controller.signal);
      if (!controller.signal.aborted) {
        setTurns((previous) => [...previous.slice(0, -1), { message: parsed.data, createdAt, result }]);
        if (result.tool === "start_booking") {
          const prefill = result.data;
          void startBooking(prefill?.doctorProfileId, prefill?.date, prefill?.time, prefill?.specialty);
        }
        if (voiceTurn !== undefined && continuous.current && voiceTurn === generation.current) void playReply(result.reply, index, voiceTurn);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const failure = cause instanceof AssistantApiError ? cause : new AssistantApiError("Could not connect to the assistant. Try again.");
        setError(failure);
        if (voiceTurn !== undefined && voiceTurn === generation.current) disableContinuous();
        if (failure.status === 401 || failure.status === 403) { turnCount.current = 0; setTurns([]); }
        else if (voiceTurn === undefined) setDraft(parsed.data);
        else setDraft((current) => appendSpeechTranscript(current, parsed.data));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(draft);
  }

  function closePanel() {
    if (!bookingAttempt.current) resetBooking();
    disableContinuous();
    abortVoiceInput();
    stopPlayback();
    setPlaybackNotice("");
    setVoiceError("");
    restoreFocus.current = true;
    setOpen(false);
  }

  function resetBooking() {
    if (bookingConfirming.current || (bookingAttempt.current && !bookingHold)) {
      setBookingNotice("Resolve the pending booking attempt before starting another. Retry with the same request or check your appointments.");
      return;
    }
    bookingAttempt.current = null;
    setBookingHold(null); setBookingLocked(false); setBookingDiscardable(false);
    bookingRequest.current++;
    setBookingActive(false); setBooking(emptyBookingDraft()); setBookingDoctors([]); setBookingSlots([]);
    setBookingNotice(""); setPaymentNotice(""); setBookingLoading(false);
  }

  async function loadBookingSlots(doctor: BookingDoctor, date: string, requested?: BookingSlot | string) {
    if (bookingAttempt.current) return;
    const request = ++bookingRequest.current;
    setBookingLoading(true); setBookingSlots([]);
    setBooking({ doctor, date, slot: null, timezone: "Asia/Kolkata", fee: doctor.consultationFeeInr });
    try {
      const query = new URLSearchParams({ doctorProfileId: doctor.id, date });
      const response = await fetch(`/api/appointments/availability?${query}`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Could not load availability. Try another date.");
      const data = bookingAvailabilitySchema.parse(await response.json());
      if (request !== bookingRequest.current) return;
      if (data.doctorProfileId !== doctor.id || data.date !== date) throw new Error("Availability did not match your selection.");
      const timezone = data.timezone === "IST" ? "Asia/Kolkata" : data.timezone;
      new Intl.DateTimeFormat("en-IN", { timeZone: timezone });
      let slot: BookingSlot | null = null;
      if (requested) {
        if (typeof requested === "string") {
          const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
          slot = data.slots.find((item) => formatter.format(new Date(item.startsAt)) === requested) ?? null;
        } else {
          slot = data.slots.find((item) => item.startsAt === requested.startsAt && item.endsAt === requested.endsAt) ?? null;
        }
      }
      setBooking({ doctor, date, slot, timezone, fee: doctor.consultationFeeInr });
      setBookingSlots(data.slots);
      if (requested && !slot) {
        const reqLabel = typeof requested === "string" ? `Requested time ${requested}` : "That slot";
        setBookingNotice(`${reqLabel} is not available. Choose an open slot below.`);
      } else if (slot) {
        setBookingNotice("Review your selection and confirm, or choose another slot.");
      } else if (data.slots.length) {
        setBookingNotice("Choose an available time.");
      } else {
        setBookingNotice("No slots available. Choose another date.");
      }
    } catch {
      if (request === bookingRequest.current) setBookingNotice("Could not load availability. Try another date.");
    } finally { if (request === bookingRequest.current) setBookingLoading(false); }
  }

  async function startBooking(doctorId?: string, date?: string, slotOrTime?: BookingSlot | string, specialty?: string) {
    if (!bookingStorageReady.current || bookingStorageBlocked.current) {
      setBookingActive(true); setBookingNotice("Booking recovery is unavailable. Check your appointments before trying again."); return;
    }
    if (bookingAttempt.current) { setBookingNotice("Finish or recover the current booking attempt first."); return; }
    const request = ++bookingRequest.current;
    setBookingActive(true); setBooking(emptyBookingDraft()); setBookingSlots([]); setBookingLoading(true);
    setBookingNotice("Choose a doctor.");
    try {
      const response = await fetch("/api/doctors", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Doctors unavailable");
      const doctors = bookingDoctorsSchema.parse(await response.json());
      if (request !== bookingRequest.current) return;
      setBookingDoctors(doctors);
      let doctor = doctors.find((item) => item.id === doctorId);
      if (!doctor && specialty) {
        const specMatches = doctors.filter((item) =>
          item.specialty.toLowerCase() === specialty.toLowerCase() ||
          item.specialty.toLowerCase().includes(specialty.toLowerCase())
        );
        if (specMatches.length === 1) {
          doctor = specMatches[0];
        }
      }
      if (doctor && date) { void loadBookingSlots(doctor, date, slotOrTime); return; }
      if (doctor) {
        setBooking({ ...emptyBookingDraft(), doctor, fee: doctor.consultationFeeInr });
        setBookingNotice("When would you like to visit? Choose a day below to see available times.");
        return;
      }
      if (date) {
        setBooking({ ...emptyBookingDraft(), date, timezone: "Asia/Kolkata" });
        setBookingNotice("Date selected. Choose a doctor from the list.");
        return;
      }
    } catch { if (request === bookingRequest.current) setBookingNotice("Could not load doctors. Try again or use the booking page."); }
    finally { if (request === bookingRequest.current) setBookingLoading(false); }
  }

  function handleBookingText(message: string) {
    if (/^(?:cancel|reset|start over)$/i.test(message.trim())) { resetBooking(); return; }
    if (bookingLoading) { setBookingNotice("Please wait for the current selection to load."); return; }
    if (bookingAttempt.current) { setBookingNotice("Use the booking controls to review or retry the current attempt."); return; }
    if (!booking.doctor) {
      const doctor = matchDoctor(message, bookingDoctors);
      if (!doctor) { setBookingNotice("Choose one doctor or enter a unique doctor name."); return; }
      setBooking({ ...emptyBookingDraft(), doctor, fee: doctor.consultationFeeInr }); setBookingNotice("When would you like to visit? Choose a day below to see available times."); return;
    }
    if (!booking.date) {
      const date = parseBookingDate(message, booking.timezone);
      if (!date) { setBookingNotice("Enter today, tomorrow, or a date in YYYY-MM-DD format."); return; }
      void loadBookingSlots(booking.doctor, date); return;
    }
    if (!booking.slot) {
      const slot = matchSlot(message, bookingSlots, booking.timezone);
      if (!slot) { setBookingNotice("Choose one listed time, including AM or PM if needed."); return; }
      setBooking({ ...booking, slot }); setBookingNotice("Review your selection."); return;
    }
    setBookingNotice("Use Confirm to review next steps, or reset the draft.");
  }

  async function confirmBooking() {
    if (bookingConfirming.current || bookingHold || !booking.doctor || !booking.slot) return;
    bookingConfirming.current = true;
    setBookingDiscardable(false);
    setBookingLoading(true); setBookingNotice("Preparing your appointment request…");
    if (!patientId || !bookingStorageReady.current || bookingStorageBlocked.current || !navigator.locks) {
      bookingConfirming.current = false; setBookingLoading(false);
      setBookingNotice("Safe booking recovery is unavailable in this browser. Check your appointments before booking again."); return;
    }
    const doctor = booking.doctor;
    let result: Awaited<ReturnType<typeof createBookingHold>> | undefined;
    let cleared = true;
    try {
      await navigator.locks.request(bookingStorageKey(patientId), async () => {
        const session = await fetch("/api/auth/get-session", { credentials: "include", cache: "no-store" });
        const identity = session.ok ? await session.json() : null;
        if (identity?.user?.id !== patientId) throw new Error("Session changed");
        const stored = readBookingAttempt(window.localStorage, patientId);
        if (stored.kind === "invalid" || stored.kind === "unavailable") throw new Error("Saved attempt unavailable");
        if (stored.kind === "found" && (!bookingAttempt.current || JSON.stringify(stored.attempt) !== JSON.stringify(bookingAttempt.current))) {
          restoreBookingAttempt(stored.attempt); return;
        }
        if (!bookingAttempt.current) {
          const attempt = { key: crypto.randomUUID(), payload: { doctorProfileId: doctor.id, startsAt: booking.slot!.startsAt, endsAt: booking.slot!.endsAt } };
          if (!saveBookingAttempt(window.localStorage, patientId, attempt)) throw new Error("Could not save attempt");
          bookingAttempt.current = attempt;
          setBookingLocked(true);
        } else if (stored.kind !== "found") {
          throw new Error("Saved attempt missing");
        }
        const currentSession = await fetch("/api/auth/get-session", { credentials: "include", cache: "no-store" });
        const currentIdentity = currentSession.ok ? await currentSession.json() : null;
        if (currentIdentity?.user?.id !== patientId) throw new Error("Session changed");
        setBookingNotice("Creating your appointment hold…");
        result = await createBookingHold(bookingAttempt.current, fetch, patientId);
        if (result.kind === "result" && bookingMounted.current) cleared = clearBookingAttempt(window.localStorage, patientId);
      });
    } catch {
      setBookingNotice("Could not safely save or recover this request. Check your session and browser storage, then retry.");
    } finally { bookingConfirming.current = false; setBookingLoading(false); }
    if (!result || !bookingMounted.current) return;
    if (result.kind === "result") {
      if (cleared) bookingAttempt.current = null;
      setBookingHold(result.hold);
      setBookingNotice(!cleared ? "Your booking result was found, but the saved request could not be cleared. Check your browser storage."
        : result.hold.status === "pending_payment" && result.hold.holdExpiresAt && Date.parse(result.hold.holdExpiresAt) > Date.now()
        ? "Slot held temporarily. Payment is required; the appointment is not yet confirmed."
        : result.hold.status === "scheduled"
        ? "Your appointment is confirmed. You can ask me about your bookings or start another conversation."
        : "This attempt no longer has an active hold. Check your appointments for its current status.");
    } else if (result.kind === "conflict") {
      setBookingDiscardable(true);
      setBookingNotice("That slot is unavailable. The saved attempt is retained; check your appointments before trying another slot.");
    } else if (result.kind === "key_conflict") {
      setBookingNotice("This booking key conflicts with an earlier request. Check your appointments before starting another booking.");
    } else if (result.kind === "rejected") {
      setBookingNotice("The request was rejected. Check your session and retry, or check your appointments.");
    } else {
      setBookingNotice("We could not confirm the result. Retry to use the same booking request, or check your appointments.");
    }
  }

  async function continuePayment() {
    if (paymentInFlight.current || !patientId || !bookingHold || bookingHold.status !== "pending_payment") return;
    // eslint-disable-next-line react-hooks/purity -- Check the actual clock when the user clicks payment, not at render time.
    if (!bookingHold.holdExpiresAt || Date.parse(bookingHold.holdExpiresAt) <= Date.now()) {
      setPaymentNotice("This reservation has expired. Check your appointments and choose a new slot.");
      return;
    }
    paymentInFlight.current = true;
    setPaymentStage("starting"); setPaymentNotice("Preparing secure payment…");
    disableContinuous(); abortVoiceInput(); stopPlayback();
    try {
      await payForAssistantHold(bookingHold.id, patientId, launchRazorpayCheckout, fetch, (stage) => {
        setPaymentStage(stage);
        setPaymentNotice(stage === "opening" ? "Complete payment in the Razorpay window." : "Verifying your payment…");
      });
      setBookingHold({ ...bookingHold, status: "scheduled", holdExpiresAt: null });
      setBookingNotice("Payment verified. Your appointment is confirmed.");
      setPaymentNotice("Payment successful. Your appointment is confirmed.");
      router.refresh();
    } catch (error) {
      setPaymentNotice(error instanceof Error && error.message === "PAYMENT_DISMISSED"
        ? "Payment window closed. You can continue payment while your reservation is active."
        : error instanceof Error ? error.message : "Payment could not be confirmed. Check your payment history before retrying.");
    } finally { paymentInFlight.current = false; setPaymentStage(null); }
  }

  async function discardConflictedBooking() {
    if (!patientId || !bookingDiscardable || !bookingAttempt.current || bookingConfirming.current || !navigator.locks) return;
    bookingConfirming.current = true; setBookingLoading(true);
    try {
      await navigator.locks.request(bookingStorageKey(patientId), async () => {
        const session = await fetch("/api/auth/get-session", { credentials: "include", cache: "no-store" });
        const identity = session.ok ? await session.json() : null;
        if (identity?.user?.id !== patientId) throw new Error("Session changed");
        const stored = readBookingAttempt(window.localStorage, patientId);
        if (stored.kind !== "found" || JSON.stringify(stored.attempt) !== JSON.stringify(bookingAttempt.current) || !clearBookingAttempt(window.localStorage, patientId)) throw new Error("Attempt changed");
        bookingAttempt.current = null;
        setBookingDiscardable(false); setBookingLocked(false); setBookingHold(null);
        setBookingActive(false); setBooking(emptyBookingDraft()); setBookingSlots([]); setBookingNotice("");
      });
    } catch { setBookingNotice("The saved attempt changed or could not be cleared. Check your appointments."); }
    finally { bookingConfirming.current = false; setBookingLoading(false); }
  }

  function stopPlayback() {
    stopMonitor();
    playbackRequest.current += 1;
    playbackAbort.current?.abort();
    playbackAbort.current = null;
    playback.current?.stop();
    playback.current = null;
    setPlaybackIndex(null);
    setPlaybackStarting(false);
  }

  async function playReply(text: string, index: number, voiceTurn?: number) {
    if (voiceTurn === undefined && continuous.current) disableContinuous();
    stopPlayback();
    const request = playbackRequest.current;
    const controller = new AbortController();
    playbackAbort.current = controller;
    setPlaybackStarting(true);
    setPlaybackIndex(index);
    setPlaybackNotice("");
    try {
      if (speech.current) {
        abortVoiceInput();
      }
      if (voiceCleanup.current) await voiceCleanup.current;
      if (controller.signal.aborted || request !== playbackRequest.current) return;
      const audio = await synthesizeAssistantAudio(text, playbackLanguage, controller.signal);
      if (controller.signal.aborted || request !== playbackRequest.current) return;
      const session = playAssistantAudio(audio, {
        onEnd: () => {
          if (request !== playbackRequest.current) return;
          stopMonitor();
          playback.current = null; setPlaybackIndex(null);
          if (continuous.current && voiceTurn === generation.current) startVoiceInput();
        },
        onError: () => {
          if (request !== playbackRequest.current) return;
          stopMonitor();
          playback.current = null;
          setPlaybackIndex(null);
          setPlaybackNotice("Unable to speak this response. Please try again.");
          if (continuous.current) disableContinuous();
        },
      });
      playback.current = session;
      if (continuous.current && barge.current && voiceTurn === generation.current) startMonitor(request, voiceTurn);
    } catch (error) {
      if (!controller.signal.aborted) {
        setPlaybackIndex(null);
        if (continuous.current) disableContinuous();
        setPlaybackNotice(error instanceof AssistantApiError ? error.message : "Unable to speak this response. Please try again.");
      }
    } finally {
      if (request === playbackRequest.current) { playbackAbort.current = null; setPlaybackStarting(false); }
    }
  }

  function abortVoiceInput() {
    const session = speech.current;
    if (session) {
      session.cancel();
      voiceCleanup.current = session.done;
      void session.done.finally(() => { if (voiceCleanup.current === session.done) voiceCleanup.current = null; });
    }
    speech.current = null;
    setVoiceState(null);
  }

  function disableContinuous() {
    continuous.current = false;
    generation.current++;
    setContinuousEnabled(false);
    barge.current = false;
    setBargeEnabled(false);
    stopMonitor();
    abortVoiceInput();
  }

  function startVoiceInput(existing?: Awaited<ReturnType<typeof startAssistantWavRecorder>>, review = false) {
    if (speech.current || playback.current || playbackAbort.current || active.current) return false;
    if (voiceCleanup.current) {
      if (existing) return false;
      const voiceTurn = generation.current;
      void voiceCleanup.current.then(() => {
        if (continuous.current && voiceTurn === generation.current) startVoiceInput();
      });
      return false;
    }
    setVoiceError("");
    const voiceTurn = generation.current;
    let transcript = "";
    let failed = false;
    speech.current = createAssistantVoiceSession({
      start: existing ? async () => existing : startAssistantWavRecorder,
      transcribe: transcribeAssistantAudio,
      onState: setVoiceState,
      onTranscript: (text) => {
        if (!assistantMessageSchema.safeParse(text).success) {
          failed = true;
          setVoiceError(text.trim() ? "That voice message is too long. Try a shorter sentence." : "No words were recognized. Speak closer to the microphone and try again.");
        }
        else if (review) {
          setDraft((current) => appendSpeechTranscript(current, text));
          setPlaybackNotice("Review the interrupted message, then press Send.");
        }
        else if (continuous.current && voiceTurn === generation.current) transcript = text;
        else setDraft((current) => appendSpeechTranscript(current, text));
      },
      onError: (cause) => { failed = true; setVoiceError(cause instanceof AssistantApiError ? cause.message
        : cause instanceof Error && cause.message === "No speech was detected. Try again or type your message."
          ? cause.message
        : cause instanceof Error && cause.message === "Audio recording is unavailable in this browser."
          ? "Voice input is unavailable in this browser. You can type your message."
          : speechErrorMessage(cause instanceof Error ? cause.name : "")); },
      onEnd: () => {
        speech.current = null; setVoiceState(null);
        if (continuous.current && voiceTurn === generation.current) {
          if (review || failed || !transcript) disableContinuous();
          else void submit(transcript, voiceTurn);
        }
      },
    });
    return true;
  }

  function stopMonitor() {
    const current = monitor.current;
    if (!current) return;
    monitor.current = null;
    current.controller.abort();
    voiceCleanup.current = current.done;
    void current.done.finally(() => { if (voiceCleanup.current === current.done) voiceCleanup.current = null; });
  }

  function startMonitor(request: number, voiceTurn: number) {
    if (monitor.current || speech.current) return;
    if (voiceCleanup.current) {
      void voiceCleanup.current.then(() => {
        if (continuous.current && barge.current && playback.current && request === playbackRequest.current && voiceTurn === generation.current) startMonitor(request, voiceTurn);
      });
      return;
    }
    const controller = new AbortController();
    const detect = createBargeDetector();
    let recorder: Awaited<ReturnType<typeof startAssistantWavRecorder>> | undefined;
    const current = { controller, done: Promise.resolve() };
    monitor.current = current;
    current.done = (async () => {
      try {
        recorder = await startAssistantWavRecorder(controller.signal, { onSamples: (samples) => {
          if (!recorder || monitor.current !== current || !barge.current || request !== playbackRequest.current || voiceTurn !== generation.current) return;
          if (!detect(samples)) return;
          const recording = recorder;
          monitor.current = null;
          let accepted = false;
          try {
            accepted = handoffAssistantRecorder(recording, () => {
              stopPlayback();
              recording.beginRecording();
              return startVoiceInput(recording, true);
            });
          } catch { /* The handoff releases the recorder on failure. */ }
          if (!accepted && continuous.current && voiceTurn === generation.current) {
            disableContinuous();
            setVoiceError("Voice interruption could not start. Try again.");
          }
        } });
        if (controller.signal.aborted || monitor.current !== current) { recorder.cancel(); return; }
        await recorder.result;
        if (monitor.current === current) {
          monitor.current = null;
          barge.current = false; setBargeEnabled(false);
          setPlaybackNotice("Barge-in stopped. Continue listening or use Stop speaking.");
        }
      } catch {
        if (!controller.signal.aborted && monitor.current === current) {
          monitor.current = null;
          barge.current = false; setBargeEnabled(false);
          setPlaybackNotice("Barge-in is unavailable. Continue listening or use Stop speaking.");
        }
      }
    })();
  }

  function toggleVoiceInput() {
    if (playback.current || playbackAbort.current) return;
    if (speech.current) { setVoiceState("stopping"); speech.current.stop(); }
    else startVoiceInput();
  }

  async function toggleContinuous() {
    if (continuous.current) {
      disableContinuous();
      stopPlayback();
    } else {
      abortVoiceInput();
      stopPlayback();
      continuous.current = true;
      generation.current++;
      const voiceTurn = generation.current;
      setContinuousEnabled(true);
      setVoiceError(""); setPlaybackNotice(""); setVoiceState("starting");
      try {
        const started = await startAssistantVoiceWhenReady(voiceCleanup.current,
          () => continuous.current && voiceTurn === generation.current,
          () => startVoiceInput());
        if (!started && continuous.current && voiceTurn === generation.current) {
          disableContinuous();
          setVoiceError("Voice chat could not start while another request is active. Wait for it to finish and try again.");
        }
      } catch {
        if (continuous.current && voiceTurn === generation.current) {
          disableContinuous(); setVoiceError("Microphone setup failed. Try voice chat again.");
        }
      }
    }
  }

  function toggleBarge() {
    barge.current = !barge.current;
    setBargeEnabled(barge.current);
    if (!barge.current) stopMonitor();
    else if (playback.current) startMonitor(playbackRequest.current, generation.current);
  }

  return (
    <>
      <div hidden={open} className={floatingPosition}>
        <button ref={launcher} type="button" aria-expanded={open} aria-controls={`${id}-panel`}
          aria-label="Medrella AI Assistant" title="Medrella AI Assistant"
          className="group grid size-[50px] place-items-center rounded-full border border-white/30 bg-gradient-to-br from-sky-700 via-blue-700 to-indigo-700 text-white shadow-md shadow-blue-950/20 hover:shadow-lg hover:shadow-blue-950/25 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700 motion-safe:transition motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0 motion-safe:active:scale-95"
          onClick={() => setOpen(true)}>
          <Sparkles aria-hidden="true" className="size-5 shrink-0 text-sky-100 motion-safe:transition-transform motion-safe:group-hover:rotate-12" />
        </button>
      </div>
      <section ref={panel} id={`${id}-panel`} aria-labelledby={`${id}-title`}
        className={`${floatingPosition} ${open ? "flex" : "hidden"} max-h-[min(42rem,calc(100dvh-max(1.5rem,env(safe-area-inset-bottom))-max(4.5rem,env(safe-area-inset-top))))] w-[min(26rem,calc(100vw-max(1rem,env(safe-area-inset-left))-max(1rem,env(safe-area-inset-right))))] flex-col overflow-hidden rounded-3xl border border-blue-100 bg-white shadow-2xl shadow-slate-900/15`}
        style={chatWindow.bounds ? { ...chatWindow.bounds, bottom: "auto", right: "auto", maxHeight: "none" } : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.stopPropagation();
            closePanel();
          }
        }}>
        <header className={`flex shrink-0 items-center justify-between gap-3 border-b border-blue-100 bg-gradient-to-r from-sky-50 to-indigo-50 p-4 sm:p-5 ${chatWindow.desktop ? "touch-none cursor-grab select-none outline-offset-[-3px] focus-visible:outline-2 focus-visible:outline-blue-700 active:cursor-grabbing" : ""}`}
          tabIndex={chatWindow.desktop ? 0 : undefined}
          role={chatWindow.desktop ? "group" : undefined}
          aria-label={chatWindow.desktop ? "Move assistant with arrow keys" : undefined}
          onKeyDown={(event) => chatWindow.keyboard(event, "move")}
          onPointerDown={(event) => chatWindow.start(event, "move")}
          onPointerMove={chatWindow.move} onPointerUp={chatWindow.finish}
          onPointerCancel={chatWindow.finish} onLostPointerCapture={chatWindow.finish}>
          <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0 rounded-xl bg-blue-100 p-2.5 text-blue-800"><Sparkles aria-hidden="true" className="size-5" /></span>
            <div>
              <h2 id={`${id}-title`} className="font-semibold text-slate-900">Medrella AI Assistant</h2>
              <p className="text-sm text-slate-600">{role === "patient" ? "Appointments and doctor availability" : "Your appointments and schedule"}</p>
            </div>
          </div>
          <button ref={closeButton} type="button" aria-label="Close assistant"
            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-slate-700 transition-colors hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-blue-700" onClick={closePanel}>
            <X aria-hidden="true" className="size-5" />
          </button>
        </header>
        {chatWindow.desktop && (
          <button type="button" aria-label="Resize assistant with arrow keys" title="Drag to resize"
            className="absolute left-1 top-1 grid size-6 touch-none cursor-nwse-resize place-items-center rounded-md text-blue-700 hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-blue-700"
            onKeyDown={(event) => chatWindow.keyboard(event, "resize")}
            onPointerDown={(event) => chatWindow.start(event, "resize")}
            onPointerMove={chatWindow.move} onPointerUp={chatWindow.finish}
            onPointerCancel={chatWindow.finish} onLostPointerCapture={chatWindow.finish}>
            <MoveDiagonal aria-hidden="true" className="size-3.5" />
          </button>
        )}
        <div className="@container min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
          <div aria-label="Suggested questions" className="flex shrink-0 flex-wrap gap-2">
            {role === "patient" && <Button type="button" variant="outline" size="sm" disabled={busy || blocked} onClick={() => void submit("Book an appointment")}>Book an appointment</Button>}
            {starters[role].map((starter) => (
              <Button key={starter.label} type="button" variant="outline" size="sm" disabled={busy || blocked} onClick={() => {
                if ("draft" in starter) {
                  setDraft(starter.message);
                  input.current?.focus();
                } else void submit(starter.message);
              }}>{starter.label}</Button>
            ))}
          </div>
          <ol ref={log} role="log" aria-label="Assistant conversation" aria-relevant="additions text"
            className={turns.length ? "space-y-3 [overflow-wrap:anywhere]" : "sr-only"}>
            {turns.map((turn, index) => (
              <li key={index} className="space-y-2 text-sm">
                <p className="ml-auto w-fit max-w-full rounded-xl bg-teal-50 px-3 py-2 text-teal-950"><span className="sr-only">You: </span>{turn.message}</p>
                {turn.result && (
                  <div className="space-y-2.5 rounded-xl bg-slate-50 p-3 text-slate-800 shadow-xs">
                    <div>
                      <span className="sr-only">Assistant: </span>
                      <SafeMarkdown content={turn.result.reply} />
                    </div>

                    {turn.result.tool === "clarify" && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {(turn.result.reply.toLowerCase().includes("date") ||
                          turn.result.reply.toLowerCase().includes("day") ||
                          turn.result.reply.toLowerCase().includes("when") ||
                          turn.result.reply.toLowerCase().includes("tomorrow")) && (
                          <>
                            <button
                              type="button"
                              disabled={busy || blocked}
                              onClick={() => void submit("Tomorrow")}
                              className="rounded-full border border-teal-200 bg-white px-2.5 py-1 text-xs font-medium text-teal-900 shadow-2xs transition-colors hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-teal-700"
                            >
                              Tomorrow
                            </button>
                            <button
                              type="button"
                              disabled={busy || blocked}
                              onClick={() => void submit("Today")}
                              className="rounded-full border border-teal-200 bg-white px-2.5 py-1 text-xs font-medium text-teal-900 shadow-2xs transition-colors hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-teal-700"
                            >
                              Today
                            </button>
                          </>
                        )}
                        {(turn.result.reply.toLowerCase().includes("doctor") ||
                          turn.result.reply.toLowerCase().includes("specialist") ||
                          turn.result.reply.toLowerCase().includes("who")) &&
                          bookingDoctors.slice(0, 3).map((doc) => (
                            <button
                              key={doc.id}
                              type="button"
                              disabled={busy || blocked}
                              onClick={() => void submit(doc.name)}
                              className="rounded-full border border-teal-200 bg-white px-2.5 py-1 text-xs font-medium text-teal-900 shadow-2xs transition-colors hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-teal-700"
                            >
                              {doc.name}
                            </button>
                          ))}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/60 pt-2">
                      <label htmlFor={`${id}-voice-${index}`} className="text-xs font-medium text-slate-600">Voice</label>
                      <select id={`${id}-voice-${index}`} value={playbackLanguage}
                        onChange={(event) => setPlaybackLanguage(event.target.value as "en" | "hi")}
                        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                        <option value="en">English</option><option value="hi">Hindi</option>
                      </select>
                      {playbackIndex === index ? (
                        <button type="button" onClick={() => { if (continuous.current) disableContinuous(); stopPlayback(); }} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-700">
                          <Square aria-hidden="true" className="size-3" /> Stop speaking
                        </button>
                      ) : (
                        <button type="button" disabled={playbackStarting} onClick={() => void playReply(turn.result!.reply, index)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-700 disabled:opacity-50">
                          <Volume2 aria-hidden="true" className="size-4" /> Listen
                        </button>
                      )}
                    </div>
                    <AssistantResult result={turn.result} busy={busy || blocked}
                      onAppointmentDetails={(appointmentId) => void submit(`Show appointment details ${appointmentId}`)}
                      onPatientAppointmentFilter={(filter) => void submit(`Show ${filter} appointments`)}
                      onRescheduleSuggestions={(appointmentId) => void submit(`Suggest alternative slots for appointment ${appointmentId}`)}
                      onChooseDoctor={(doctorId) => void startBooking(doctorId)}
                      onChooseSlot={(doctorId, date, startsAt, endsAt) => void startBooking(doctorId, date, { startsAt, endsAt })} />
                  </div>
                )}
              </li>
            ))}
          </ol>
          {bookingActive && (
            <section aria-label="Appointment booking draft" className="space-y-3 rounded-2xl border border-teal-200 bg-teal-50/70 p-3.5 text-sm shadow-xs">
              <div className="flex items-center justify-between gap-2 border-b border-teal-200 pb-2">
                <div className="flex items-center gap-1.5 font-semibold text-teal-950">
                  <Calendar className="size-4 text-teal-700 shrink-0" />
                  <h3>Book your appointment</h3>
                </div>
                <button
                  type="button"
                  disabled={bookingLoading || paymentStage !== null || (bookingLocked && !bookingHold)}
                  onClick={resetBooking}
                  className="text-xs font-medium text-teal-800 underline hover:text-teal-950 disabled:opacity-50"
                >
                  Reset Draft
                </button>
              </div>

              {bookingNotice && (
                <p role="status" className="rounded-lg bg-teal-100/70 px-2.5 py-1.5 text-xs text-teal-900">
                  {bookingNotice}
                </p>
              )}

              {bookingDiscardable && (
                <button
                  type="button"
                  disabled={bookingLoading}
                  onClick={() => void discardConflictedBooking()}
                  className="text-xs font-semibold text-rose-800 underline block"
                >
                  Discard unavailable attempt
                </button>
              )}

              {bookingLoading && <p className="text-xs text-teal-800 italic">Updating availability…</p>}

              {!booking.doctor && (
                <div className="space-y-1.5">
                  <span className="text-xs font-semibold text-teal-950 block">Select a Doctor:</span>
                  <div className="space-y-1.5">
                    {bookingDoctors.map((doctor) => (
                      <button
                        key={doctor.id}
                        type="button"
                        disabled={bookingLoading}
                        onClick={() => {
                          setBooking({ ...emptyBookingDraft(), doctor, fee: doctor.consultationFeeInr });
                          setBookingNotice("When would you like to visit? Choose a day below to see available times.");
                        }}
                        className="flex w-full items-center justify-between rounded-xl border border-teal-200 bg-white p-2.5 text-left text-xs transition-colors hover:bg-teal-50/80 focus-visible:outline-2 focus-visible:outline-teal-700"
                      >
                        <div className="flex items-center gap-2">
                          <Stethoscope className="size-4 text-teal-700 shrink-0" />
                          <div>
                            <p className="font-semibold text-slate-900">{doctor.name}</p>
                            <p className="text-slate-600">{doctor.specialty}</p>
                          </div>
                        </div>
                        {doctor.consultationFeeInr !== null && (
                          <span className="font-semibold text-slate-900">₹{doctor.consultationFeeInr}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {booking.doctor && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between rounded-xl border border-teal-200 bg-white p-2.5 text-xs shadow-2xs">
                    <div className="flex items-center gap-2">
                      <Stethoscope className="size-4 text-teal-700 shrink-0" />
                      <div>
                        <span className="font-semibold text-slate-900">{booking.doctor.name}</span>
                        <span className="text-slate-600 block">{booking.doctor.specialty}</span>
                      </div>
                    </div>
                    {!bookingLocked && (
                      <button
                        type="button"
                        disabled={bookingLoading}
                        onClick={() => {
                          setBooking(emptyBookingDraft());
                          setBookingSlots([]);
                          setBookingNotice("Choose a doctor.");
                        }}
                        className="text-xs text-teal-800 underline hover:text-teal-950"
                      >
                        Change Doctor
                      </button>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor={`${id}-booking-date`} className="text-xs font-semibold text-teal-950">
                        When would you like to visit?
                      </label>
                    </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={bookingLoading || bookingLocked}
                          onClick={() => {
                            const todayStr = getRelativeDateStr(0, booking.timezone);
                            if (booking.doctor) void loadBookingSlots(booking.doctor, todayStr);
                          }}
                          aria-pressed={booking.date === getRelativeDateStr(0, booking.timezone)}
                          className={`rounded-xl border p-3 text-left text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-teal-700 disabled:opacity-50 ${booking.date === getRelativeDateStr(0, booking.timezone) ? "border-teal-700 bg-teal-700 text-white" : "border-teal-200 bg-white text-teal-950 hover:bg-teal-100"}`}
                        >
                          Today
                          <span className="mt-1 block text-xs font-normal">{new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${getRelativeDateStr(0, booking.timezone)}T12:00:00Z`))}</span>
                        </button>
                        <button
                          type="button"
                          disabled={bookingLoading || bookingLocked}
                          onClick={() => {
                            const tomorrowStr = getRelativeDateStr(1, booking.timezone);
                            if (booking.doctor) void loadBookingSlots(booking.doctor, tomorrowStr);
                          }}
                          aria-pressed={booking.date === getRelativeDateStr(1, booking.timezone)}
                          className={`rounded-xl border p-3 text-left text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-teal-700 disabled:opacity-50 ${booking.date === getRelativeDateStr(1, booking.timezone) ? "border-teal-700 bg-teal-700 text-white" : "border-teal-200 bg-white text-teal-950 hover:bg-teal-100"}`}
                        >
                          Tomorrow
                          <span className="mt-1 block text-xs font-normal">{new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${getRelativeDateStr(1, booking.timezone)}T12:00:00Z`))}</span>
                        </button>
                      </div>
                    <details className="rounded-xl border border-teal-200 bg-white p-2.5">
                      <summary className="cursor-pointer text-xs font-semibold text-teal-900">Choose another date{booking.date ? ` · ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${booking.date}T12:00:00Z`))}` : ""}</summary>
                    <input
                      id={`${id}-booking-date`}
                      type="date"
                      min={getRelativeDateStr(0, booking.timezone)}
                      aria-label="Choose appointment date"
                      value={booking.date}
                      disabled={bookingLoading || bookingLocked}
                      onChange={(event) => {
                        if (event.target.value && booking.doctor) {
                          void loadBookingSlots(booking.doctor, event.target.value);
                        }
                      }}
                      className="mt-2 w-full rounded-lg border border-teal-300 bg-white p-2 text-xs text-slate-900 focus-visible:outline-2 focus-visible:outline-teal-700"
                    />
                    </details>
                    <p className="text-[11px] text-slate-600">Times shown in {booking.timezone === "Asia/Kolkata" || booking.timezone === "IST" ? "India time (IST)" : booking.timezone}. Availability is checked when you select a date.</p>
                  </div>

                  {booking.date && !bookingLoading && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-teal-950">Available Slots</span>
                        {booking.slot && !bookingLocked && (
                          <button
                            type="button"
                            disabled={bookingLoading}
                            onClick={() => {
                              setBooking({ ...booking, slot: null });
                              setBookingNotice("Choose an available time.");
                            }}
                            className="text-xs text-teal-800 underline"
                          >
                            Change Time
                          </button>
                        )}
                      </div>
                      {bookingSlots.length === 0 ? (
                        <p className="text-xs text-slate-600">No open slots on this date. Select another date above.</p>
                      ) : (
                        <div className="space-y-3">
                          {groupSlotsByPeriod(bookingSlots, booking.timezone).map((group) => (
                            <div key={group.label}>
                              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600">{group.label} · {group.slots.length} available</p>
                              <div className="grid grid-cols-1 gap-2 @min-[360px]:grid-cols-2">
                          {group.slots.map((slot) => {
                            const isSelected = booking.slot?.startsAt === slot.startsAt;
                            return (
                              <button
                                key={slot.startsAt}
                                type="button"
                                disabled={bookingLocked || bookingLoading}
                                data-booking-slot="true"
                                aria-pressed={isSelected}
                                onClick={() => {
                                  setBooking({ ...booking, slot });
                                  setBookingNotice("Review your selection and confirm.");
                                }}
                                className={`flex min-h-16 items-center gap-2 rounded-xl border p-3 text-left text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-teal-700 ${
                                  isSelected
                                    ? "border-teal-700 bg-teal-700 text-white"
                                    : "border-teal-300 bg-white text-teal-900 hover:bg-teal-100"
                                } disabled:opacity-50`}
                              >
                                <Clock className="size-3" />
                                <span><span className="block">{formatSlotRange(slot.startsAt, slot.endsAt, booking.timezone)}</span><span className="mt-1 block text-[11px] font-normal">{slotDurationLabel(slot.startsAt, slot.endsAt)} · {isSelected ? "Selected" : "Available"}</span></span>
                              </button>
                            );
                          })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {booking.slot && (
                    <div className="space-y-2 rounded-xl border border-teal-300 bg-white p-3 text-xs shadow-xs">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <span className="font-semibold text-slate-900">
                          {bookingHold ? "Booking Result" : "Review Appointment Details"}
                        </span>
                        {bookingHold ? (
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                              bookingHold.status === "pending_payment"
                                ? "border-amber-300 bg-amber-50 text-amber-800"
                                : bookingHold.status === "scheduled" || bookingHold.status === "paid"
                                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                                : "border-slate-300 bg-slate-50 text-slate-800"
                            }`}
                          >
                            {bookingHold.status === "pending_payment"
                              ? "Hold Active · Payment Pending"
                              : bookingHold.status === "scheduled"
                              ? "Confirmed & Scheduled"
                              : bookingHold.status === "paid"
                              ? "Paid & Confirmed"
                              : bookingHold.status}
                          </span>
                        ) : (
                          <span className="rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-800">
                            Draft Review
                          </span>
                        )}
                      </div>

                      <div className="space-y-1 text-slate-700">
                        <p>
                          <strong className="font-semibold text-slate-900">Doctor:</strong> {booking.doctor.name} (
                          {booking.doctor.specialty})
                        </p>
                        <p>
                          <strong className="font-semibold text-slate-900">Time:</strong> {booking.date} ·{" "}
                          {formatSlotRange(booking.slot.startsAt, booking.slot.endsAt, booking.timezone)}{" "}
                          ({booking.timezone})
                        </p>
                        <p>
                          <strong className="font-semibold text-slate-900">Consultation Fee:</strong>{" "}
                          {booking.fee === null ? "Free / Included" : `₹${booking.fee}`}
                        </p>
                        {bookingHold && (
                          <>
                            <p>
                              <strong className="font-semibold text-slate-900">Appointment ID:</strong>{" "}
                              <span className="font-mono text-[11px]">{bookingHold.id}</span>
                            </p>
                            {bookingHold.holdExpiresAt && (
                              <p className="text-amber-800 font-medium">
                                Hold expires:{" "}
                                {new Intl.DateTimeFormat("en-IN", {
                                  dateStyle: "medium",
                                  timeStyle: "medium",
                                  timeZone: booking.timezone,
                                }).format(new Date(bookingHold.holdExpiresAt))}
                              </p>
                            )}
                          </>
                        )}
                      </div>

                      <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-2 items-center justify-between">
                        {bookingNotice && !bookingHold && (
                          <p role="status" className={`w-full rounded-lg px-3 py-2 text-xs ${bookingLocked ? "bg-amber-50 text-amber-900" : "bg-teal-50 text-teal-900"}`}>
                            {bookingNotice}
                          </p>
                        )}
                        {bookingHold ? (
                          bookingHold.status === "pending_payment" ? (
                            <button
                              type="button"
                              disabled={paymentStage !== null}
                              onClick={() => void continuePayment()}
                              className="inline-flex w-full items-center justify-center rounded-lg bg-teal-700 px-3 py-3 text-xs font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-60 shadow-xs"
                            >
                              {paymentStage === "verifying" ? "Verifying payment…" : paymentStage ? "Opening Razorpay…" : "Continue to Payment"}
                            </button>
                          ) : (
                            <Link
                              href="/patient/dashboard"
                              className="text-xs font-semibold text-teal-800 underline hover:text-teal-950"
                            >
                              View Your Appointments
                            </Link>
                          )
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            disabled={bookingLoading}
                            onClick={() => void confirmBooking()}
                            className="w-full bg-teal-700 hover:bg-teal-800 text-white font-semibold shadow-xs"
                          >
                            {bookingLocked ? "Retry Confirmation" : "Confirm Booking"}
                          </Button>
                        )}
                      </div>
                      {paymentNotice && <p role="status" className="rounded-lg bg-slate-50 p-2 text-xs text-slate-800">{paymentNotice}</p>}
                    </div>
                  )}
                </div>
              )}

              {!bookingHold && <div className="pt-1 text-center">
                <Link
                  href={
                    booking.doctor
                      ? bookingReviewUrl(
                          booking.date && booking.slot
                            ? { doctorProfileId: booking.doctor.id, date: booking.date, ...booking.slot }
                            : { doctorProfileId: booking.doctor.id }
                        )
                      : "/patient/book-appointment"
                  }
                  className="text-xs text-teal-800 underline hover:text-teal-950"
                >
                  Open full booking page
                </Link>
              </div>}
            </section>
          )}
          <p role="status" className={busy ? "text-sm text-slate-600" : "sr-only"}>{busy ? "Assistant is responding…" : ""}</p>
          {playbackNotice && <p role="status" className="text-xs text-slate-600">{playbackNotice}</p>}
          {error && (
            <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {error.message} {error.status === 401 && <Link href="/login" className="font-semibold underline">Sign in</Link>}
            </div>
          )}
        </div>
          <form onSubmit={handleSubmit} className="shrink-0 space-y-1.5 border-t border-slate-200 bg-white p-4 sm:px-5">
            {continuousEnabled && <p role="status" className="flex items-center gap-2 text-xs text-teal-800"><span className="size-2 animate-pulse rounded-full bg-teal-500" />{playbackIndex !== null ? "Speaking… listening resumes after the reply." : busy ? "Thinking…" : voiceState === "transcribing" ? "Understanding your words…" : "Listening… pause to send automatically."}</p>}
            {continuousEnabled && <div>
              <button type="button" role="switch" aria-checked={bargeEnabled} onClick={toggleBarge}
                className="rounded px-1 py-1 text-sm font-medium text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-700">
                Barge-in: {bargeEnabled ? "On" : "Off"}
              </button>
              {bargeEnabled && <p className="text-xs text-slate-600">Headphones recommended. Interrupted messages must be reviewed before sending.</p>}
            </div>}
            <label htmlFor={`${id}-input`} className="sr-only">Message</label>
            {draftHint && <p id={`${id}-hint`} className="text-xs text-slate-600">{draftHint}</p>}
            <div className="flex min-w-0 items-center gap-1 rounded-3xl border border-slate-200 bg-slate-50 p-1.5 focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-100">
              <Input ref={input} id={`${id}-input`} value={draft} onChange={(event) => setDraft(event.target.value)}
                maxLength={1000} autoComplete="off" aria-describedby={draftHint ? `${id}-hint` : undefined}
                placeholder="Message Medrella…"
                disabled={busy || blocked} className="h-10 min-w-0 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0" />
              <Button type="button" variant="outline"
                aria-label={voiceState ? "Stop voice input" : "Start voice input"}
                aria-pressed={Boolean(voiceState)}
                title={voiceState === "listening" ? "Stop recording" : "Voice input · pauses finish automatically"}
                disabled={busy || blocked || paymentStage !== null || (voiceState !== null && voiceState !== "listening") || playbackStarting || playbackIndex !== null}
                className={`size-10 shrink-0 rounded-full border-0 px-0 shadow-none ${voiceState === "listening" ? "animate-pulse bg-rose-100 text-rose-700" : "bg-white text-slate-600 hover:bg-teal-50 hover:text-teal-800"}`} onClick={toggleVoiceInput}>
                {voiceState === "starting" || voiceState === "stopping" || voiceState === "transcribing" ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : voiceState ? <Square aria-hidden="true" className="size-4" /> : <Mic aria-hidden="true" className="size-5" />}
              </Button>
              <Button type="button" variant="outline" role="switch" aria-label="Live voice conversation" aria-checked={continuousEnabled}
                title={continuousEnabled ? "End voice chat" : "Start voice chat"}
                disabled={!continuousEnabled && (busy || blocked || paymentStage !== null || !historyReady)}
                onClick={() => void toggleContinuous()}
                className={`size-10 shrink-0 rounded-full border-0 px-0 shadow-none ${continuousEnabled ? "bg-teal-700 text-white hover:bg-teal-800" : "bg-white text-slate-600 hover:bg-teal-50 hover:text-teal-800"}`}>
                {continuousEnabled ? <Square aria-hidden="true" className="size-4" /> : <AudioLines aria-hidden="true" className="size-5" />}
              </Button>
              <Button type="submit" aria-label="Send message" title="Send message" className="size-10 shrink-0 rounded-full bg-teal-700 px-0 hover:bg-teal-800" disabled={busy || blocked || !draft.trim()}>
                <Send aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2 px-2 pt-1 text-[10px] text-slate-500">
              <span>{continuousEnabled ? "Voice chat on · tap ■ to end" : "Mic: dictate · Wave: voice chat"}</span>
              <button type="button" disabled={busy || paymentStage !== null} onClick={() => clearChat()} className="shrink-0 underline disabled:opacity-50">Clear chat</button>
            </div>
            <p role="status" className={voiceState ? "text-xs text-slate-600" : "sr-only"}>
              {voiceState === "starting" ? "Starting microphone…" : voiceState === "listening" ? "Listening… pause to finish, or tap the stop button." : voiceState === "stopping" ? "Finishing voice input…" : voiceState === "transcribing" ? "Transcribing recording…" : ""}
            </p>
            {voiceError && <p role="alert" className="text-xs text-red-800">{voiceError}</p>}
          </form>
      </section>
    </>
  );
}
