"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AssistantApiError, cancellationReasons, confirmAssistantCancellation, type CancellationReason } from "@/lib/assistant-api";

export function AssistantCancellation({ appointmentId, status, busy }: {
  appointmentId: string;
  status: string;
  busy: boolean;
}) {
  const id = useId();
  const pending = useRef(false);
  const [review, setReview] = useState(false);
  const [reason, setReason] = useState<CancellationReason | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    if (!review || !reason || pending.current || busy || cancelled) return;
    pending.current = true;
    setSubmitting(true);
    setError("");
    try {
      await confirmAssistantCancellation(appointmentId, reason);
      setCancelled(true);
    } catch (cause) {
      setError(cause instanceof AssistantApiError ? cause.message : "Cancellation could not be confirmed. Check your appointment status.");
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  if (cancelled) return <p role="status">Appointment cancelled. Check your appointment history for refund updates if you paid.</p>;
  return (
    <>
      <p className="text-slate-600">{status}</p>
      {review ? (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-2">
          <p>Cancel this appointment and release its time slot? Eligible payments will follow the existing refund process.</p>
          <label htmlFor={id} className="block font-semibold">Cancellation reason</label>
          <select id={id} value={reason} required disabled={submitting}
            className="w-full rounded-md border border-slate-300 bg-white p-2"
            onChange={(event) => setReason(event.target.value as CancellationReason | "")}>
            <option value="">Choose a reason</option>
            {Object.entries(cancellationReasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          {error && <p role="alert" className="text-red-800">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!reason || busy || submitting}
              className="bg-red-700 hover:bg-red-800" onClick={() => void confirm()}>
              {submitting ? "Cancelling…" : "Confirm cancellation"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={submitting} onClick={() => {
              setReview(false);
              setReason("");
              setError("");
            }}>Keep appointment</Button>
          </div>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setReview(true)}>Cancel appointment</Button>
      )}
    </>
  );
}
