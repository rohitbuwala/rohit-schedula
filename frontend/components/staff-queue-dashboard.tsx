"use client";
import { AppointmentQueue } from "@/components/appointment-queue";
import { ClipboardCheck, Stethoscope, Ticket } from "lucide-react";

export function StaffQueueDashboard() {
  return <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-8">
    <header className="rounded-3xl bg-teal-950 p-6 text-white sm:p-8"><p className="text-xs font-bold uppercase tracking-widest text-teal-200">Clinic staff workspace</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">Reception &amp; patient check-in</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-teal-100">Welcome patients, verify their booking token and check them in. Keep arrivals and the waiting queue in one place.</p>
      <ol className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
        <li className="flex items-center gap-3 rounded-xl bg-white/10 p-3"><Ticket className="size-5 shrink-0 text-teal-200" aria-hidden="true" /><span><strong className="block">1. Find the booking</strong><span className="text-xs text-teal-100">Token is assigned when booked</span></span></li>
        <li className="flex items-center gap-3 rounded-xl bg-white/10 p-3"><ClipboardCheck className="size-5 shrink-0 text-teal-200" aria-hidden="true" /><span><strong className="block">2. Check in on arrival</strong><span className="text-xs text-teal-100">Patient receives a queue position</span></span></li>
        <li className="flex items-center gap-3 rounded-xl bg-white/10 p-3"><Stethoscope className="size-5 shrink-0 text-teal-200" aria-hidden="true" /><span><strong className="block">3. Follow the queue</strong><span className="text-xs text-teal-100">Doctor starts the consultation</span></span></li>
      </ol></header>
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"><AppointmentQueue role="staff" /></div>
  </div>;
}
