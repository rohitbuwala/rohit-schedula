import Link from "next/link";

export function DoctorApplicationLink() {
  return <div className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
    <p className="text-sm text-slate-600">Interested in joining as a provider?</p>
    <Link href="/patient/doctor-application" className="mt-2 inline-flex rounded-lg border border-teal-700 px-4 py-2 text-sm font-semibold text-teal-800 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600">
      Apply to become a doctor
    </Link>
  </div>;
}
