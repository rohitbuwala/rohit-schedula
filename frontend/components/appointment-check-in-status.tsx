import { CheckCircle2, Clock, Ticket } from "lucide-react";
import { attendanceLabel, type Attendance } from "@/lib/queue-response";

export function AppointmentCheckInStatus({ attendance, loading = false, unavailable = false }: { attendance?: Attendance; loading?: boolean; unavailable?: boolean }) {
  if (!attendance) return <p className="mt-3 text-xs text-slate-500">{loading ? "Checking attendance…" : unavailable ? "Check-in status unavailable. Refresh to try again." : "Check in with clinic staff when you arrive."}</p>;
  const active = attendance.status === "waiting" || attendance.status === "in_service";
  return <div className={`mt-3 rounded-xl border p-3 text-sm ${active ? "border-teal-200 bg-teal-50 text-teal-950" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
    <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />{attendanceLabel(attendance.status)}</p>
    {attendance.tokenNumber !== null && <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
      <span className="inline-flex items-center gap-1.5"><Ticket className="size-4" aria-hidden="true" />Token <strong className="text-lg">{attendance.tokenNumber}</strong></span>
      {attendance.position !== null && <span className="inline-flex items-center gap-1.5"><Clock className="size-4" aria-hidden="true" />Position <strong>{attendance.position}</strong></span>}
    </div>}
    {attendance.status === "waiting" && <p className="mt-1 text-xs">Your token stays the same. Your position updates as the queue moves.</p>}
    {attendance.checkedInAt && <p className="mt-1 text-xs">Checked in at {new Intl.DateTimeFormat("en-IN", { timeZone: attendance.timezone ?? "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(attendance.checkedInAt))} ({attendance.timezone ?? "Asia/Kolkata"})</p>}
  </div>;
}
