export default function AdminPage() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-bold">Administration</h1>
      <p className="mt-2 text-gray-400">
        Operator roles, capabilities, and audit access. Authorization is enforced
        server-side; the browser never receives infrastructure credentials.
      </p>
      <div className="mt-6 rounded-lg border border-dashed border-gray-700 p-8 text-center text-gray-500">
        Placeholder — identity wiring arrives with live Supabase auth.
      </div>
    </main>
  );
}
