"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  LogOut,
  Stethoscope,
  ShieldCheck,
  Building,
  GraduationCap,
  Calendar,
  IndianRupee,
  FileText,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { parseDoctorApplicationResponseBody, type DoctorApplicationResponse } from "@/lib/doctor-application-response";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export function DoctorApplicationStatus() {
  const router = useRouter();
  const [application, setApplication] = useState<DoctorApplicationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  async function loadStatus() {
    setError("");
    try {
      const response = await fetch(`${backendUrl}/api/doctor-applications/me`, {
        credentials: "include",
        cache: "no-store",
      });

      if (response.status === 401) {
        router.replace("/login");
        return;
      }

      if (!response.ok) {
        throw new Error("Unable to retrieve application status.");
      }

      const text = await response.text();
      const parsed = parseDoctorApplicationResponseBody(text);
      setApplication(parsed);

      // If approved, give user option or redirect
      if (parsed?.status === "approved") {
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load application status.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void loadStatus();
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleSignOut() {
    await authClient.signOut();
    startTransition(() => {
      router.replace("/login");
      router.refresh();
    });
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 text-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-teal-700 border-r-transparent align-[-0.125em]" />
        <p className="mt-4 text-sm font-medium text-slate-600">Checking your doctor verification status…</p>
      </div>
    );
  }

  if (!application) {
    return (
      <Card className="mx-auto w-full max-w-xl border-slate-200">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-600 mb-2">
            <FileText className="h-6 w-6" />
          </div>
          <CardTitle className="text-xl">No Doctor Application Found</CardTitle>
          <CardDescription>
            You are logged in, but we could not find an active doctor application associated with your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <Link
              href="/signup/doctor"
              className="inline-flex flex-1 items-center justify-center rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 transition-colors"
            >
              Submit Doctor Application
            </Link>
            <Link
              href="/patient/dashboard"
              className="inline-flex flex-1 items-center justify-center rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Go to Patient Dashboard
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isApproved = application.status === "approved";
  const isRejected = application.status === "rejected";
  const isReviewPending = application.status === "pending";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8 sm:px-6">
      {/* Status Banner */}
      <Card
        className={`border-2 ${
          isApproved
            ? "border-emerald-500 bg-emerald-50/40"
            : isRejected
              ? "border-red-300 bg-red-50/40"
              : "border-amber-400 bg-amber-50/30"
        }`}
      >
        <CardContent className="p-6">
          <div className="flex flex-col items-center text-center space-y-3 sm:flex-row sm:items-start sm:text-left sm:gap-4 sm:space-y-0">
            <div
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${
                isApproved
                  ? "bg-emerald-100 text-emerald-800"
                  : isRejected
                    ? "bg-red-100 text-red-800"
                    : "bg-amber-100 text-amber-800"
              }`}
            >
              {isApproved ? (
                <CheckCircle2 className="h-8 w-8" />
              ) : isRejected ? (
                <AlertTriangle className="h-8 w-8" />
              ) : (
                <Clock className="h-8 w-8 animate-pulse" />
              )}
            </div>

            <div className="flex-1 space-y-1">
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${
                    isApproved
                      ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                      : isRejected
                        ? "bg-red-100 text-red-800 border border-red-200"
                        : "bg-amber-100 text-amber-800 border border-amber-200"
                  }`}
                >
                  {isApproved ? "Approved & Verified" : isRejected ? "Application Declined" : "Under Administrative Review"}
                </span>
                <span className="text-xs text-slate-500">ID: {application.id.slice(0, 8)}…</span>
              </div>

              <h2 className="text-xl font-bold text-slate-900">
                {isApproved
                  ? "Your Doctor Profile is Approved!"
                  : isRejected
                    ? "Application Verification Notice"
                    : "Doctor Verification in Progress"}
              </h2>

              <p className="text-sm text-slate-600">
                {isApproved
                  ? "Congratulations! Your clinical credentials have been confirmed by Medrella administration. Your doctor dashboard and patient booking directory are now active."
                  : isRejected
                    ? "Our credentialing team was unable to verify your clinical credentials with the provided information. Please review the details below or contact Medrella support."
                    : "Thank you for registering. Medrella verifies all medical registration numbers and council certifications to ensure high clinical standards. Review usually takes 24–48 hours."}
              </p>

              {isRejected && application.rejectionReason && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900">
                  <span className="font-bold">Administrative Feedback:</span> &ldquo;{application.rejectionReason}&rdquo;
                </div>
              )}

              {isApproved && (
                <div className="pt-3">
                  <Link
                    href="/doctor/dashboard"
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 transition-colors"
                  >
                    <Stethoscope className="h-4 w-4" />
                    Enter Doctor Dashboard
                  </Link>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Progress Timeline Stepper */}
      {isReviewPending && (
        <Card className="border-slate-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-800 uppercase tracking-wider">
              Verification Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="space-y-1">
                <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">
                  ✓
                </div>
                <p className="text-xs font-semibold text-slate-900">Account Created</p>
                <p className="text-[11px] text-slate-500">Completed</p>
              </div>

              <div className="space-y-1">
                <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 text-amber-800 text-xs font-bold border-2 border-amber-400 animate-pulse">
                  2
                </div>
                <p className="text-xs font-semibold text-amber-900">License Check</p>
                <p className="text-[11px] text-amber-700 font-medium">In Progress</p>
              </div>

              <div className="space-y-1">
                <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-400 text-xs font-bold">
                  3
                </div>
                <p className="text-xs font-semibold text-slate-400">Practice Live</p>
                <p className="text-[11px] text-slate-400">Pending</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Submitted Application Details */}
      <Card className="border-slate-200">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-base font-semibold text-slate-900">Submitted Credentials</CardTitle>
            <CardDescription className="text-xs">
              Submitted on{" "}
              {new Date(application.submittedAt).toLocaleDateString("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              IST
            </CardDescription>
          </div>
          <span className="rounded bg-slate-100 px-2 py-1 text-xs font-mono text-slate-600">
            {application.specialty}
          </span>
        </CardHeader>
        <CardContent className="space-y-4 divide-y divide-slate-100 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <DetailItem icon={<Stethoscope className="h-4 w-4" />} label="Specialty" value={application.specialty} />
            <DetailItem
              icon={<ShieldCheck className="h-4 w-4" />}
              label="License Number"
              value={application.licenseNumber}
            />
            <DetailItem
              icon={<GraduationCap className="h-4 w-4" />}
              label="Licensing Region"
              value={application.licenseRegion}
            />
            <DetailItem
              icon={<GraduationCap className="h-4 w-4" />}
              label="Qualifications"
              value={application.qualifications ?? "Not provided"}
            />
            <DetailItem
              icon={<Calendar className="h-4 w-4" />}
              label="Experience"
              value={`${application.yearsOfExperience ?? 0} years`}
            />
            <DetailItem
              icon={<IndianRupee className="h-4 w-4" />}
              label="Consultation Fee"
              value={`₹${application.consultationFeeInr ?? 500}`}
            />
          </div>

          {(application.clinicName || application.clinicAddress) && (
            <div className="pt-3 space-y-2">
              <DetailItem
                icon={<Building className="h-4 w-4" />}
                label="Clinic / Hospital"
                value={`${application.clinicName ?? ""}${
                  application.clinicAddress ? ` — ${application.clinicAddress}` : ""
                }`}
              />
            </div>
          )}

          {application.bio && (
            <div className="pt-3">
              <p className="text-xs font-semibold text-slate-500 mb-1">Professional Bio</p>
              <p className="text-xs text-slate-700 bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                {application.bio}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Toolbar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void loadStatus()}
          className="w-full sm:w-auto text-slate-700 hover:text-slate-900 border-slate-300"
        >
          <RotateCw className="mr-2 h-4 w-4" />
          Refresh Status
        </Button>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void handleSignOut()}
            disabled={isPending}
            className="w-full sm:w-auto text-slate-600 hover:text-red-700 hover:bg-red-50"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-center text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

function DetailItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <span className="text-teal-700">{icon}</span>
        <span>{label}</span>
      </div>
      <p className="font-medium text-slate-900">{value}</p>
    </div>
  );
}
