"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AssistantApiError, confirmAssistantReschedule, getAssistantRescheduleOptions, type RescheduleOptions, type RescheduleSlot } from "@/lib/assistant-api";

export function AssistantReschedule({ appointmentId, busy }: { appointmentId: string; busy: boolean }) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [options, setOptions] = useState<RescheduleOptions | null>(null);
  const [selected, setSelected] = useState<RescheduleSlot | null>(null);
  const [updated, setUpdated] = useState<RescheduleSlot | null>(null);
  const [error, setError] = useState("");

  async function run(action: () => Promise<void>) {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof AssistantApiError ? cause.message : "Could not complete the reschedule request."); }
    finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function format(slot: RescheduleSlot) {
    const timezone = options?.timezone ?? "Asia/Kolkata";
    const formatter = new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium", timeStyle: "short", timeZone: timezone === "IST" ? "Asia/Kolkata" : timezone,
    });
    return `${formatter.formatRange(new Date(slot.startsAt), new Date(slot.endsAt))} (${timezone})`;
  }

  if (updated) return <p role="status">Appointment rescheduled to {format(updated)}.</p>;
  return (
    <div className="space-y-2">
      {!options ? (
        <Button type="button" size="sm" variant="outline" disabled={busy || pending}
          onClick={() => void run(async () => setOptions(await getAssistantRescheduleOptions(appointmentId)))}>
          {pending ? "Checking availability…" : "Reschedule appointment"}
        </Button>
      ) : (
        <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-2">
          <p className="font-semibold">Choose a new time</p>
          {options.slots.length === 0 && <p>No alternative slots were found in the next 30 calendar days.</p>}
          <div className="flex flex-wrap gap-2">
            {options.slots.map((slot) => (
              <Button key={slot.startsAt} type="button" size="sm" variant={slot === selected ? "default" : "outline"}
                aria-pressed={slot === selected} disabled={busy || pending} onClick={() => setSelected(slot)}>
                {format(slot)}
              </Button>
            ))}
          </div>
          {selected && <p>New time: <strong>{format(selected)}</strong></p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!selected || busy || pending} onClick={() => {
              if (!selected) return;
              void run(async () => {
                try { setUpdated(await confirmAssistantReschedule(appointmentId, options.currentStartsAt, selected)); }
                catch (cause) {
                  if (cause instanceof AssistantApiError && cause.status === 409) {
                    setSelected(null);
                    setOptions(null);
                  }
                  throw cause;
                }
              });
            }}>{pending ? "Rescheduling…" : "Confirm reschedule"}</Button>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => {
              setOptions(null);
              setSelected(null);
              setError("");
            }}>Keep current time</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-red-800">{error}</p>}
    </div>
  );
}
