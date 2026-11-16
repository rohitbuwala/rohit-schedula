"use client";
import { AppointmentQueue } from "@/components/appointment-queue";

export function StaffQueueDashboard() {
  return <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-8">
    <header><p className="text-xs font-bold uppercase tracking-wide text-teal-700">Clinic staff workspace</p>
      <h1 className="mt-2 text-2xl font-bold text-slate-950">Patient check-in</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">View your assigned doctors, welcome arriving patients and manage attendance. Doctors start and complete consultations.</p></header>
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"><AppointmentQueue role="staff" /></div>
  </div>;
}
