import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Supabase cookie/session TRANSPORT for Control (server-side only).
 *
 * @supabase/ssr here is plumbing: it parses/refreshes the session cookies.
 * The authoritative verification of any session still happens inside
 * services/identity (SupabaseSessionVerifier), never in the browser.
 */

export const controlAuthEnv = () => ({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

export const isControlAuthConfigured = () => {
  const env = controlAuthEnv();
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
};

/** Request-scoped client for middleware (cookies flow request -> response). */
export const createControlRequestClient = (request: NextRequest) => {
  const env = controlAuthEnv();
  let response = NextResponse.next();
  const client = createServerClient(env.supabaseUrl as string, env.supabaseAnonKey as string, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  return { client, getResponse: () => response };
};

/** Cookie-store client for server components / route handlers. */
export const createControlCookieClient = () => {
  const env = controlAuthEnv();
  const jar = cookies();
  return createServerClient(env.supabaseUrl as string, env.supabaseAnonKey as string, {
    cookies: {
      getAll: async () => (await jar).getAll(),
      setAll: async (list) => {
        for (const { name, value, options } of list) (await jar).set(name, value, options);
      },
    },
  });
};
