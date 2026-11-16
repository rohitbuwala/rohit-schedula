import { Button } from "@/components/ui/button";
import type { AssistantResponse, PatientAppointmentFilter } from "@/lib/assistant-api";
import { AssistantCancellation } from "./assistant-cancellation";
import { AssistantReschedule } from "./assistant-reschedule";
import {
  Calendar,
  Clock,
  CreditCard,
  Pill,
  Stethoscope,
} from "lucide-react";
import {
  appointmentStatuses,
  appointmentTimeRange,
  formatCurrencyInr,
  formatSlotRange,
  slotDurationLabel,
  getPaymentStatusBadgeConfig,
  getStatusBadgeConfig,
  groupSlotsByPeriod,
  paymentStatuses,
  refundStatuses,
  weekdays,
} from "./assistant-ui-helpers";

const paymentAppointmentTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function clock(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function MoreResults({ show }: { show: boolean }) {
  return show ? <p className="text-xs text-slate-500 italic">Additional results are available.</p> : null;
}

export function StatusBadge({ status }: { status: keyof typeof appointmentStatuses | string }) {
  const config = getStatusBadgeConfig(status);
  return <span className={config.className}>{config.label}</span>;
}

export function PaymentStatusBadge({ status }: { status: keyof typeof paymentStatuses | string }) {
  const config = getPaymentStatusBadgeConfig(status);
  return <span className={config.className}>{config.label}</span>;
}

export function AssistantResult({
  result,
  onAppointmentDetails,
  onPatientAppointmentFilter,
  onRescheduleSuggestions,
  onChooseDoctor,
  onChooseSlot,
  busy,
}: {
  result: AssistantResponse;
  onAppointmentDetails: (id: string) => void;
  onPatientAppointmentFilter: (filter: PatientAppointmentFilter) => void;
  onRescheduleSuggestions: (id: string) => void;
  onChooseDoctor: (id: string) => void;
  onChooseSlot: (id: string, date: string, startsAt: string, endsAt: string) => void;
  busy: boolean;
}) {
  const { tool, data } = result;

  switch (tool) {
    case "clarify":
    case "start_booking":
      return null;

    case "search_doctors":
      return (
        <div className="space-y-2.5">
          <ul className="space-y-2.5">
            {data.doctors.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs transition-shadow hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                      <Stethoscope className="size-5" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-900 leading-snug">{item.name}</h4>
                      <span className="inline-block mt-0.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {item.specialty}
                      </span>
                    </div>
                  </div>
                  {item.consultationFeeInr !== null && (
                    <div className="text-right">
                      <span className="text-[11px] text-slate-500 block">Consultation Fee</span>
                      <span className="font-semibold text-slate-900 text-sm">
                        {formatCurrencyInr(item.consultationFeeInr)}
                      </span>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-end border-t border-slate-100 pt-2.5">
                  <Button
                    type="button"
                    size="sm"
                    className="w-full sm:w-auto bg-teal-700 hover:bg-teal-800 text-white font-medium shadow-xs"
                    disabled={busy}
                    onClick={() => onChooseDoctor(item.id)}
                    aria-label={`Select ${item.name} and view slots`}
                  >
                    Select Doctor / View Slots
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <MoreResults show={data.hasMore} />
        </div>
      );

    case "alternative_slots":
    case "check_availability": {
      const slotGroups = groupSlotsByPeriod(data.slots, data.timezone);
      const formattedDate = new Intl.DateTimeFormat("en-IN", {
        dateStyle: "full",
        timeZone: data.timezone === "IST" ? "Asia/Kolkata" : data.timezone,
      }).format(new Date(`${data.date}T00:00:00Z`));

      return (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <Calendar className="size-4 text-teal-700 shrink-0" />
              <span>{formattedDate}</span>
            </div>
            <span className="text-xs text-slate-500">
              {data.durationMinutes} min / slot · {data.timezone}
            </span>
          </div>

          {data.slots.length === 0 ? (
            <p className="text-xs text-slate-600 py-1">No available appointment slots found for this date.</p>
          ) : (
            <div className="space-y-3">
              {slotGroups.map((group) => (
                <div key={group.label} className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block">
                    {group.label}
                  </span>
                  <div className="grid grid-cols-1 gap-2 @min-[360px]:grid-cols-2">
                    {group.slots.map((item) => (
                      <button
                        key={item.startsAt}
                        type="button"
                        disabled={busy}
                        onClick={() => onChooseSlot(data.doctorProfileId, data.date, item.startsAt, item.endsAt)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50/60 px-2.5 py-1.5 text-xs font-medium text-teal-900 transition-colors hover:bg-teal-100 hover:border-teal-300 focus-visible:outline-2 focus-visible:outline-teal-700 active:bg-teal-200 disabled:opacity-50"
                        aria-label={`Select ${formatSlotRange(item.startsAt, item.endsAt, data.timezone)} on ${data.date}`}
                      >
                        <Clock className="size-3 text-teal-700 shrink-0" />
                        <span className="text-left"><span className="block">{formatSlotRange(item.startsAt, item.endsAt, data.timezone)}</span><span className="block text-[11px] font-normal">{slotDurationLabel(item.startsAt, item.endsAt)} · Available</span></span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    case "list_appointments": {
      const zone = "Asia/Kolkata";
      return (
        <div className="space-y-3">
          <div role="group" aria-label="Filter appointments" className="flex flex-wrap gap-2">
            {(["upcoming", "past", "all"] as const).map((filter) => (
              <Button
                key={filter}
                type="button"
                variant={data.filter === filter ? "default" : "outline"}
                size="sm"
                aria-pressed={data.filter === filter}
                disabled={busy}
                className="capitalize"
                onClick={() => {
                  if (data.filter !== filter) onPatientAppointmentFilter(filter);
                }}
              >
                {filter}
              </Button>
            ))}
          </div>

          {(["upcoming", "past"] as const).map((period) => {
            const appointments = data.appointments.filter((item) => item.period === period);
            return (
              appointments.length > 0 && (
                <div key={period} className="space-y-2">
                  <h3 className="font-semibold text-xs text-slate-500 uppercase tracking-wider capitalize">
                    {period} appointments ({zone})
                  </h3>
                  <ul className="space-y-2.5">
                    {appointments.map((item) => (
                      <li key={item.id} className="space-y-2 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-slate-900">{item.doctor.name}</p>
                            <span className="text-xs text-slate-600">{item.doctor.specialty}</span>
                          </div>
                          <StatusBadge status={item.status} />
                        </div>

                        <div className="flex items-center gap-1.5 text-xs text-slate-700">
                          <Clock className="size-3.5 text-slate-500 shrink-0" />
                          <span>{appointmentTimeRange(item.startsAt, item.endsAt, zone)}</span>
                        </div>

                        {item.status === "scheduled" || item.status === "pending_payment" ? (
                          <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-2 items-center">
                            <AssistantCancellation
                              appointmentId={item.id}
                              status={appointmentStatuses[item.status as keyof typeof appointmentStatuses] ?? item.status}
                              busy={busy}
                            />
                            {item.status === "scheduled" && (
                              <AssistantReschedule appointmentId={item.id} busy={busy} />
                            )}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            );
          })}
          <MoreResults show={data.hasMore} />
        </div>
      );
    }

    case "payment_history":
      return (
        <div className="space-y-2.5">
          <ul className="space-y-2.5">
            {data.payments.map((item, index) => (
              <li
                key={`${item.appointmentStartsAt}-${index}`}
                className="space-y-2 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                      <CreditCard className="size-4" />
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900 leading-tight">{item.doctorName}</p>
                      <p className="text-xs text-slate-500">
                        {paymentAppointmentTime.format(new Date(item.appointmentStartsAt))} IST
                      </p>
                    </div>
                  </div>
                  <PaymentStatusBadge status={item.paymentStatus} />
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-xs">
                  <div>
                    <span className="text-slate-500">Amount: </span>
                    <span className="font-semibold text-slate-900">
                      {new Intl.NumberFormat("en-IN", { style: "currency", currency: item.currency }).format(
                        item.amountPaise / 100
                      )}
                    </span>
                  </div>
                  {item.refundStatus && (
                    <div>
                      <span className="text-slate-500">Refund: </span>
                      <span className="font-medium text-slate-800">
                        {refundStatuses[item.refundStatus] ?? item.refundStatus}
                      </span>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <MoreResults show={data.hasMore} />
        </div>
      );

    case "list_prescriptions":
      return (
        <div className="space-y-2.5">
          <ul className="space-y-2.5">
            {data.prescriptions.map((prescription, index) => (
              <li
                key={`${prescription.issuedAt}-${index}`}
                className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs"
              >
                <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-teal-50 text-teal-700">
                      <Pill className="size-4" />
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900 leading-snug">{prescription.doctorName}</p>
                      <p className="text-[11px] text-slate-500">
                        Issued: {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(prescription.issuedAt))}
                      </p>
                    </div>
                  </div>
                </div>

                <ul className="space-y-1.5 pl-1">
                  {prescription.medications.map((medication, medicationIndex) => (
                    <li key={`${medication.name}-${medicationIndex}`} className="rounded-lg bg-slate-50 p-2 text-xs">
                      <p className="font-semibold text-slate-900">{medication.name}</p>
                      <p className="mt-0.5 whitespace-pre-line text-slate-600">{medication.instructions}</p>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <MoreResults show={data.hasMore} />
        </div>
      );

    case "today_appointments": {
      const zone = data.timezone;
      return (
        <div className="space-y-2.5">
          {data.appointments.length > 0 && <p className="text-xs text-slate-500">{zone}</p>}
          <ul className="space-y-2">
            {data.appointments.map((item) => (
              <li key={item.id} className="space-y-2 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-800">
                    <Clock className="size-3.5 text-slate-500 shrink-0" />
                    <span>{appointmentTimeRange(item.startsAt, item.endsAt, zone)}</span>
                  </div>
                  <StatusBadge status={item.status} />
                </div>
                <div className="pt-1 flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`View details for ${appointmentTimeRange(item.startsAt, item.endsAt, zone)}`}
                    onClick={() => onAppointmentDetails(item.id)}
                  >
                    View details
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <MoreResults show={data.hasMore} />
        </div>
      );
    }

    case "doctor_appointments_by_date":
      return (
        <div className="space-y-2.5">
          <p className="text-xs text-slate-500 font-medium">
            {data.date} ({data.timezone})
          </p>
          <ul className="space-y-2">
            {data.appointments.map((item, index) => (
              <li key={`${item.startsAt}-${index}`} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3 shadow-xs">
                <div className="flex items-center gap-1.5 text-xs text-slate-800">
                  <Clock className="size-3.5 text-slate-500 shrink-0" />
                  <span>{appointmentTimeRange(item.startsAt, item.endsAt, data.timezone)}</span>
                </div>
                <StatusBadge status={item.status} />
              </li>
            ))}
          </ul>
          <MoreResults show={data.hasMore} />
        </div>
      );

    case "next_available_slot":
      return data.slot ? (
        <div className="inline-flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-medium text-teal-950">
          <Clock className="size-3.5 text-teal-700 shrink-0" />
          <span>{appointmentTimeRange(data.slot.startsAt, data.slot.endsAt, data.timezone)} ({data.timezone})</span>
        </div>
      ) : null;

    case "appointment_statistics":
      return (
        <div className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2">
            <span className="text-xs font-semibold text-slate-800">Appointment Statistics</span>
            <span className="text-xs text-slate-500">{data.date} ({data.timezone})</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-slate-50 p-2 text-center">
              <span className="text-xs text-slate-500 block">Total</span>
              <span className="text-lg font-bold text-slate-900">{data.total}</span>
            </div>
            {(Object.keys(appointmentStatuses) as (keyof typeof appointmentStatuses)[]).map((status) => (
              <div key={status} className="rounded-lg bg-slate-50 p-2 text-center">
                <span className="text-xs text-slate-500 block">{appointmentStatuses[status]}</span>
                <span className="text-base font-semibold text-slate-900">{data.byStatus[status] ?? 0}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "schedule_conflicts":
      return (
        <div className="space-y-2.5">
          <p className="text-xs text-rose-700 font-medium">
            Conflicts during: {appointmentTimeRange(data.startsAt, data.endsAt, data.timezone)} ({data.timezone})
          </p>
          <ul className="space-y-2">
            {data.conflicts.map((item) => (
              <li key={item.id} className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50/50 p-3 shadow-xs">
                <span className="text-xs text-slate-800">{appointmentTimeRange(item.startsAt, item.endsAt, data.timezone)}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={`View details for ${appointmentTimeRange(item.startsAt, item.endsAt, data.timezone)}`}
                  onClick={() => onAppointmentDetails(item.id)}
                >
                  View details
                </Button>
              </li>
            ))}
          </ul>
          <MoreResults show={data.hasMore} />
        </div>
      );

    case "reschedule_suggestions":
      return data.slots.length ? (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-xs">
          <span className="text-xs font-semibold text-slate-700 block">Suggested alternative slots ({data.timezone}):</span>
          <div className="flex flex-wrap gap-1.5">
            {data.slots.map((item) => (
              <span
                key={item.startsAt}
                className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-900"
              >
                <Clock className="size-3 text-blue-600 shrink-0" />
                {appointmentTimeRange(item.startsAt, item.endsAt, data.timezone)}
              </span>
            ))}
          </div>
        </div>
      ) : null;

    case "appointment_details":
      return (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-800">
              {appointmentTimeRange(data.startsAt, data.endsAt, data.timezone)} ({data.timezone})
            </span>
            <StatusBadge status={data.status} />
          </div>
          {data.status === "scheduled" && (
            <div className="pt-2 border-t border-slate-100 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onRescheduleSuggestions(data.id)}
              >
                Suggest alternative slots
              </Button>
            </div>
          )}
        </div>
      );

    case "view_schedule":
      return (
        <dl className="space-y-2 rounded-xl border border-slate-200 bg-white p-3.5 text-xs shadow-xs">
          <div className="flex justify-between border-b border-slate-100 pb-1.5">
            <dt className="font-semibold text-slate-700">Working hours</dt>
            <dd className="text-slate-900">{clock(data.startHour)}–{clock(data.endHour)} · {data.timezone}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-100 pb-1.5">
            <dt className="font-semibold text-slate-700">Working days</dt>
            <dd className="text-slate-900">{data.activeDays.map((day) => weekdays[day]).join(", ") || "None"}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-100 pb-1.5">
            <dt className="font-semibold text-slate-700">Slot duration</dt>
            <dd className="text-slate-900">{data.slotDurationMinutes} minutes</dd>
          </div>
          {data.breakStart && data.breakEnd && (
            <div className="flex justify-between border-b border-slate-100 pb-1.5">
              <dt className="font-semibold text-slate-700">Break</dt>
              <dd className="text-slate-900">{data.breakStart}–{data.breakEnd}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="font-semibold text-slate-700">Leave dates</dt>
            <dd className="text-slate-900">{data.leaveDates.join(", ") || "None"}</dd>
          </div>
        </dl>
      );
  }
}
