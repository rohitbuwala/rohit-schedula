import { redirect } from "next/navigation";
import Link from "next/link";
import { User, Stethoscope, ArrowRight, CheckCircle2, ShieldCheck, CalendarCheck, Clock, Users } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Card } from "@/components/ui/card";
import { getPostLoginRedirect, getVerifiedSession } from "@/lib/auth-server";

export const instant = false;

export default async function SignupPage() {
  const session = await getVerifiedSession();
  if (session) {
    const destination = await getPostLoginRedirect();
    redirect(destination);
  }

  return (
    <>
      <SiteHeader />
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-4xl space-y-8">
          <div className="text-center space-y-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-teal-800 border border-teal-200">
              Join Medrella Healthcare
            </span>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Choose your registration path
            </h1>
            <p className="mx-auto max-w-xl text-base text-slate-600">
              Whether you are seeking expert medical care or expanding your healthcare practice, Medrella provides a seamless clinical experience.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* Patient Card */}
            <Card className="group relative flex flex-col justify-between border-2 border-slate-200 bg-white p-6 shadow-sm transition-all hover:border-teal-600 hover:shadow-md">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-50 text-teal-700 border border-teal-200 group-hover:bg-teal-700 group-hover:text-white transition-colors">
                    <User className="h-6 w-6" />
                  </div>
                  <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 border border-emerald-200">
                    Immediate Access
                  </span>
                </div>

                <div>
                  <h2 className="text-xl font-bold text-slate-900">PATIENT</h2>
                  <p className="mt-1 text-sm font-medium text-teal-700">Find doctors and book appointments.</p>
                  <p className="mt-2 text-sm text-slate-600">
                    Connect with certified specialists, view real-time availability in IST, and book visits in just a few clicks.
                  </p>
                </div>

                <div className="space-y-2.5 border-t border-slate-100 pt-4 text-xs text-slate-600">
                  <div className="flex items-center gap-2">
                    <CalendarCheck className="h-4 w-4 text-teal-600 shrink-0" />
                    <span>Real-time slot scheduling with instant confirmation</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-teal-600 shrink-0" />
                    <span>Accurate Asia/Kolkata (IST) appointment slots</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-teal-600 shrink-0" />
                    <span>Manage, cancel, or reschedule visits at any time</span>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-2">
                <Link
                  href="/signup/patient"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2"
                >
                  Register as Patient
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Link>
              </div>
            </Card>

            {/* Doctor Card */}
            <Card className="group relative flex flex-col justify-between border-2 border-slate-200 bg-white p-6 shadow-sm transition-all hover:border-teal-600 hover:shadow-md">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-50 text-teal-700 border border-teal-200 group-hover:bg-teal-700 group-hover:text-white transition-colors">
                    <Stethoscope className="h-6 w-6" />
                  </div>
                  <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700 border border-blue-200">
                    Verified Practice
                  </span>
                </div>

                <div>
                  <h2 className="text-xl font-bold text-slate-900">DOCTOR</h2>
                  <p className="mt-1 text-sm font-medium text-teal-700">Join Medrella as a healthcare professional.</p>
                  <p className="mt-2 text-sm text-slate-600">
                    Publish your clinical schedule, consult verified patients, and manage your practice with full administrative autonomy.
                  </p>
                </div>

                <div className="space-y-2.5 border-t border-slate-100 pt-4 text-xs text-slate-600">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-teal-600 shrink-0" />
                    <span>Verified medical credential badge for patient trust</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-teal-600 shrink-0" />
                    <span>Configurable appointment intervals (15, 30, 45, 60 min)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-teal-600 shrink-0" />
                    <span>Dedicated doctor dashboard for patient consultations</span>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-2">
                <Link
                  href="/signup/doctor"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2"
                >
                  Register as Doctor
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Link>
              </div>
            </Card>
          </div>

          <div className="text-center text-sm text-slate-600">
            Already have an account?{" "}
            <Link className="font-semibold text-teal-800 hover:underline" href="/login">
              Log in
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
