import Link from "next/link";
import {
  Activity,
  CalendarCheck2,
  Clock,
  ShieldCheck,
  Stethoscope,
  ArrowRight,
  HeartPulse,
  Building,
} from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Top Navigation */}
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur sticky top-0 z-50">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5 font-bold tracking-tight text-slate-900 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-teal-700 to-cyan-600 text-white shadow-sm shadow-teal-700/20 group-hover:scale-105 transition-transform">
              <Activity className="h-5 w-5" />
            </div>
            <span className="text-xl font-bold tracking-tight text-slate-900">
              Med<span className="text-teal-700">rella</span>
            </span>
          </Link>
          <nav className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-xl px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 transition"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 transition shadow-sm"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-6 pt-16 pb-20">
          <div className="grid lg:grid-cols-12 gap-12 items-center">
            <div className="lg:col-span-7 space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800">
                <HeartPulse className="h-3.5 w-3.5 text-teal-700" />
                Modern Healthcare & Clinic Platform
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl lg:text-6xl leading-[1.15]">
                Seamless care scheduling for patients & physicians.
              </h1>
              <p className="max-w-xl text-lg text-slate-600 leading-relaxed">
                Medrella connects patients with board-approved specialists, guarantees conflict-free slot bookings with database exclusion constraints, and streamlines daily clinic consultation queues.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Link
                  href="/signup"
                  className="inline-flex items-center gap-2 rounded-xl bg-teal-700 px-6 py-3.5 text-base font-semibold text-white shadow-md shadow-teal-700/25 hover:bg-teal-800 transition"
                >
                  Book an appointment
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-base font-semibold text-slate-700 hover:bg-slate-50 transition shadow-xs"
                >
                  Doctor workspace
                </Link>
              </div>

              {/* Trust badges */}
              <div className="grid grid-cols-3 gap-4 pt-8 border-t border-slate-200/80">
                <div>
                  <p className="text-2xl font-bold text-slate-900">100%</p>
                  <p className="text-xs text-slate-500 font-medium">Verified Physicians</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-teal-700">Zero</p>
                  <p className="text-xs text-slate-500 font-medium">Overlapping Bookings</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900">Instant</p>
                  <p className="text-xs text-slate-500 font-medium">Queue Synchronization</p>
                </div>
              </div>
            </div>

            {/* Visual Card Showcase */}
            <div className="lg:col-span-5">
              <div className="relative rounded-3xl border border-teal-100 bg-gradient-to-br from-teal-50/70 via-white to-cyan-50/70 p-6 sm:p-8 shadow-xl shadow-teal-900/5">
                <div className="space-y-4">
                  {/* Doctor Card Preview */}
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-50 text-teal-700 border border-teal-200">
                          <Stethoscope className="h-6 w-6" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-900">Dr. Sarah Jenkins</p>
                          <p className="text-xs text-teal-700 font-medium">Cardiology Specialist</p>
                        </div>
                      </div>
                      <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
                        Available Today
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-500 pt-2 border-t border-slate-100">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5 text-slate-400" /> 10:00 AM UTC
                      </span>
                      <span className="flex items-center gap-1">
                        <Building className="h-3.5 w-3.5 text-slate-400" /> Apex Heart Care
                      </span>
                    </div>
                  </div>

                  {/* Consultation Queue Preview */}
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Today&apos;s Clinic Queue
                      </p>
                      <span className="text-xs font-medium text-teal-700">3 Consultations</span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                        <span className="font-semibold text-slate-800">Johnathan Doe</span>
                        <span className="rounded-full bg-teal-100 px-2 py-0.5 font-medium text-teal-800">
                          Scheduled
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-lg bg-emerald-50/70 px-3 py-2 text-xs">
                        <span className="font-semibold text-slate-800">Elena Rostova</span>
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
                          Completed
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Security / Quality Badge */}
                  <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-teal-700 to-cyan-800 p-4 text-white shadow-md">
                    <ShieldCheck className="h-8 w-8 text-teal-300 shrink-0" />
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-teal-200">
                        Verified Credentials
                      </p>
                      <p className="text-xs text-white/90">
                        Every practicing doctor profile undergoes administrator verification before listing.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Feature Highlights Grid */}
        <section className="border-t border-slate-200 bg-white py-16">
          <div className="mx-auto max-w-6xl px-6">
            <div className="text-center max-w-2xl mx-auto mb-12">
              <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">Platform Features</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
                Engineered for healthcare reliability
              </h2>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-6 space-y-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-100 text-teal-800">
                  <CalendarCheck2 className="h-5 w-5" />
                </div>
                <h3 className="font-bold text-slate-900 text-lg">Guaranteed Slot Integrity</h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  PostgreSQL exclusion constraints and row-level locking prevent accidental double-bookings under concurrent patient traffic.
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-6 space-y-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-blue-800">
                  <Stethoscope className="h-5 w-5" />
                </div>
                <h3 className="font-bold text-slate-900 text-lg">Physician Workspace</h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Doctors manage daily queues, consultation histories, and practice details from a dedicated dashboard.
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-6 space-y-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-100 text-purple-800">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <h3 className="font-bold text-slate-900 text-lg">Admin Application Oversight</h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Hospital and clinic administrators review credentials, qualifications, and clinic registrations before activating doctor accounts.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-8">
        <div className="mx-auto flex max-w-6xl flex-col sm:flex-row items-center justify-between gap-4 px-6 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-teal-700" />
            <span className="font-bold text-slate-800">Medrella Healthcare Systems</span>
            <span>&copy; {new Date().getFullYear()}</span>
          </div>
          <p>Secure, role-based access for patients and registered healthcare professionals.</p>
        </div>
      </footer>
    </div>
  );
}
