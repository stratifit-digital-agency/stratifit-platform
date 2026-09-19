"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Minimal audience sign-in for Stratifit Media (Stage 2.14 D2.14-3).
 *
 * This is authentication plumbing ONLY — NOT a signup or onboarding system.
 * Credentials go directly to Supabase Auth; the browser never receives any
 * server-side secret (anon key is public by design). After sign-in the
 * session persists as cookies and the audience user row is provisioned
 * JIT by services/identity on first server-side resolution (D1). Success
 * returns the caller to where they came from via the `next` parameter.
 */
export default function MediaLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const signIn = async () => {
    setPending(true);
    setError(null);
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL as string,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
      );
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next") ?? "/";
      window.location.assign(next.startsWith("/") ? next : "/");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">Stratifit Media</h1>
      <p className="mt-2 text-sm text-gray-400">
        Sign in to continue watching. Watching public content needs no account.
      </p>
      <div className="mt-6 space-y-3">
        <input
          className="w-full rounded-md border border-gray-700 bg-gray-900 p-3 text-sm"
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded-md border border-gray-700 bg-gray-900 p-3 text-sm"
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button
          className="w-full rounded-md bg-white p-3 text-sm font-semibold text-gray-900 disabled:opacity-50"
          onClick={signIn}
          disabled={pending || !email || !password}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </main>
  );
}
