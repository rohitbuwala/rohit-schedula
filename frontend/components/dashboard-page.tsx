import Link from "next/link";
import { SiteHeader } from "@/components/site-header";

export function DashboardPage({ name, kind }: { name: string; kind: "Patient" | "Doctor" }) {
  return <><SiteHeader /><main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12"><p className="text-sm font-semibold uppercase tracking-wider text-teal-700">{kind} workspace</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Welcome, {name}</h1><p className="mt-3 max-w-xl text-slate-600">You are signed in to your secure {kind.toLowerCase()} account.</p><div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6"><h2 className="font-semibold text-slate-900">Your Medrella workspace</h2><p className="mt-2 text-sm text-slate-600">Your account access is verified by the server. More tools will appear here as they become available.</p></div><Link className="mt-6 inline-block text-sm font-medium text-teal-800 hover:underline" href="/">Return to home</Link></main></>;
}
