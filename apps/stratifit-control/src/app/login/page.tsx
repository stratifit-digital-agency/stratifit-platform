"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Minimal operator sign-in for Stratifit Control (email + password).
 * Credentials go directly to Supabase Auth; the browser never receives any
 * server-side secret. Successful sign-in redirects to /auth/callback, which
 * persists the session cookies server-side. Operator accounts themselves are
 * provisioned by the approved runbook (OQ-4) — sign-in alone grants nothing.
 */
export default function LoginPage() {
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
      window.location.assign("/auth/callback");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">Stratifit Control</h1>
      <p className="mt-2 text-sm text-gray-400">Operator sign-in. Authorization is enforced server-side.</p>
      <div className="mt-6 space-y-3">
        <input
          className="w-full rounded-md border border-gray-700 bg-gray-900 p-3 text-sm"
          type="email"
          placeholder="operator email"
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
        <button
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={pending || !email || !password}
          onClick={() => void signIn()}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </main>
  );
}
