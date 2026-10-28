import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6">
      <header className="flex h-20 items-center justify-between border-b border-slate-200">
        <Link href="/" className="text-xl font-bold tracking-tight text-teal-800">Schedula</Link>
        <nav className="flex gap-3"><Link className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/login">Log in</Link><Link className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800" href="/signup">Create account</Link></nav>
      </header>
      <section className="grid flex-1 items-center gap-10 py-16 md:grid-cols-2">
        <div><p className="mb-4 text-sm font-semibold uppercase tracking-[.2em] text-teal-700">Care, made simple</p><h1 className="max-w-xl text-5xl font-bold tracking-tight text-slate-900 sm:text-6xl">A better way to manage your health.</h1><p className="mt-6 max-w-lg text-lg leading-8 text-slate-600">Sign in to continue to your Schedula workspace. Patients and approved doctors have separate, secure spaces.</p><Link href="/signup" className="mt-8 inline-flex rounded-lg bg-teal-700 px-6 py-3 font-semibold text-white hover:bg-teal-800">Get started</Link></div>
        <div className="rounded-3xl border border-teal-100 bg-gradient-to-br from-teal-50 to-cyan-50 p-10"><div className="rounded-2xl bg-white p-8 shadow-sm"><p className="text-sm font-medium text-teal-700">YOUR CARE, CONNECTED</p><h2 className="mt-3 text-2xl font-semibold text-slate-900">Welcome to Schedula</h2><p className="mt-3 text-slate-600">A secure place for your healthcare journey.</p></div></div>
      </section>
      <footer className="border-t border-slate-200 py-6 text-sm text-slate-500">Secure access for patients and healthcare professionals.</footer>
    </main>
  );
}
