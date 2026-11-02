"use client";

import { useState } from "react";
import { CreditCard, UserCheck } from "lucide-react";
import { AdminDoctorApplications } from "@/components/admin-doctor-applications";
import { AdminPaymentsRefunds } from "@/components/admin-payments-refunds";

export function AdminDashboard() {
  const [activeSection, setActiveSection] = useState<"applications" | "payments">("applications");

  return (
    <div className="space-y-6">
      {/* Top Admin Section Switcher */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-4">
        <button
          type="button"
          onClick={() => setActiveSection("applications")}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition ${
            activeSection === "applications"
              ? "bg-teal-700 text-white shadow-xs"
              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          }`}
        >
          <UserCheck className="h-4 w-4" />
          Doctor Applications
        </button>
        <button
          type="button"
          onClick={() => setActiveSection("payments")}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition ${
            activeSection === "payments"
              ? "bg-teal-700 text-white shadow-xs"
              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          }`}
        >
          <CreditCard className="h-4 w-4" />
          Payments & Refunds
        </button>
      </div>

      {/* Render Active Section */}
      {activeSection === "applications" ? (
        <AdminDoctorApplications />
      ) : (
        <AdminPaymentsRefunds />
      )}
    </div>
  );
}
