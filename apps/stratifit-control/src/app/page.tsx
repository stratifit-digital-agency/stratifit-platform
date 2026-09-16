import Link from "next/link";

const sections = [
  { href: "/productions", label: "Productions", desc: "Plan and track productions" },
  { href: "/publishing", label: "Publishing", desc: "Publication records and targets" },
  { href: "/admin", label: "Administration", desc: "Permissions and audit" },
];

export default function ControlHome() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-8">
        <p className="text-sm text-gray-400">Internal · Authorized operators only</p>
        <h1 className="text-3xl font-bold">Stratifit Control</h1>
        <p className="mt-2 text-gray-400">
          Production operating system for the Stratifit platform.
        </p>
      </header>
      <section className="grid gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-lg border border-gray-800 bg-gray-900 p-6 transition-colors hover:border-gray-600"
          >
            <h2 className="text-lg font-semibold">{s.label}</h2>
            <p className="mt-1 text-sm text-gray-400">{s.desc}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}
