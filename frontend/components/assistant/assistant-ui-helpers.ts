export const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const appointmentStatuses = {
  pending_payment: "Pending payment",
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
} as const;

export const paymentStatuses = {
  created: "Pending payment",
  captured: "Paid",
  failed: "Failed",
  refunded: "Refunded",
} as const;

export const refundStatuses = {
  pending: "Pending",
  processed: "Processed",
  failed: "Failed",
} as const;

export type SlotItem = { startsAt: string; endsAt: string };

export type SlotGroup = {
  label: "Morning" | "Afternoon" | "Evening";
  slots: SlotItem[];
};

export function groupSlotsByPeriod(slots: SlotItem[], timezone: string): SlotGroup[] {
  const timeZone = timezone === "IST" ? "Asia/Kolkata" : timezone;
  const morning: SlotItem[] = [];
  const afternoon: SlotItem[] = [];
  const evening: SlotItem[] = [];

  for (const slot of slots) {
    const date = new Date(slot.startsAt);
    const hourStr = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(date);
    const hour = parseInt(hourStr, 10);
    if (hour < 12) {
      morning.push(slot);
    } else if (hour < 16) {
      afternoon.push(slot);
    } else {
      evening.push(slot);
    }
  }

  const groups: SlotGroup[] = [];
  if (morning.length > 0) groups.push({ label: "Morning", slots: morning });
  if (afternoon.length > 0) groups.push({ label: "Afternoon", slots: afternoon });
  if (evening.length > 0) groups.push({ label: "Evening", slots: evening });
  return groups;
}

export function formatSlotTime(startsAt: string, timezone: string): string {
  const timeZone = timezone === "IST" ? "Asia/Kolkata" : timezone;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startsAt));
}

export function appointmentTimeRange(startsAt: string, endsAt: string, timezone: string): string {
  const timeZone = timezone === "IST" ? "Asia/Kolkata" : timezone;
  const format = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone });
  return format.formatRange(new Date(startsAt), new Date(endsAt));
}

export function formatSlotRange(startsAt: string, endsAt: string, timezone: string): string {
  return `${formatSlotTime(startsAt, timezone)} – ${formatSlotTime(endsAt, timezone)}`;
}

export function slotDurationLabel(startsAt: string, endsAt: string): string {
  return `${(new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60000} min`;
}

export function formatCurrencyInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

export function getStatusBadgeConfig(status: keyof typeof appointmentStatuses | string) {
  const styles: Record<string, string> = {
    scheduled: "bg-emerald-50 text-emerald-800 border-emerald-200",
    pending_payment: "bg-amber-50 text-amber-800 border-amber-200",
    completed: "bg-blue-50 text-blue-800 border-blue-200",
    cancelled: "bg-rose-50 text-rose-800 border-rose-200",
  };
  const label = (appointmentStatuses as Record<string, string>)[status] ?? status;
  return {
    label,
    className: `inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles[status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`,
  };
}

export function getPaymentStatusBadgeConfig(status: keyof typeof paymentStatuses | string) {
  const styles: Record<string, string> = {
    captured: "bg-emerald-50 text-emerald-800 border-emerald-200",
    refunded: "bg-blue-50 text-blue-800 border-blue-200",
    created: "bg-amber-50 text-amber-800 border-amber-200",
    failed: "bg-rose-50 text-rose-800 border-rose-200",
  };
  const label = (paymentStatuses as Record<string, string>)[status] ?? status;
  return {
    label,
    className: `inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles[status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`,
  };
}

export function getRelativeDateStr(offsetDays: number, timezone: string): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const tz = timezone === "IST" ? "Asia/Kolkata" : timezone;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}
