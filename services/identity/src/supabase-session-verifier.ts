/**
 * Supabase session verifier adapter — the ONLY place a Supabase dependency
 * lives inside services/identity (D3 boundary). Server-side only.
 *
 * The session reference is the bearer JWT; verification is delegated to
 * Supabase Auth (auth.getUser). emailVerified is derived from
 * email_confirmed_at — provider state, never a client claim (DATA_FLOW s6).
 */
import { createClient } from "@supabase/supabase-js";
import type { SessionVerifier, VerifiedSession } from "./types";

export interface SupabaseSessionVerifierOptions {
  url: string;
  anonKey: string;
}

export const createSupabaseSessionVerifier = (
  options: SupabaseSessionVerifierOptions,
): SessionVerifier => {
  const admin = createClient(options.url, options.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async verify(sessionRef) {
      if (!sessionRef) return null;
      const token = sessionRef.replace(/^Bearer\s+/i, "").trim();
      if (!token) return null;
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user) return null;
      return {
        subject: data.user.id,
        email: data.user.email ?? null,
        emailVerified: data.user.email_confirmed_at != null,
      };
    },
  };
};
