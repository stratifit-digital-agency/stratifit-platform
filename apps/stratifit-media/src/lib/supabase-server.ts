import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Supabase cookie/session TRANSPORT for Media (server-side only, Stage 2.14
 * D2.14-3 minimum plumbing).
 *
 * @supabase/ssr here is plumbing: it parses/refreshes the session cookies.
 * The authoritative verification of any session still happens inside
 * services/identity (SupabaseSessionVerifier via the public identity
 * fragment), never in the browser. Media is a PUBLIC app: middleware uses
 * this client only to REFRESH cookies — it never gates or redirects.
 */

export const mediaAuthEnv = () => ({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

export const isMediaAuthConfigured = () => {
  const env = mediaAuthEnv();
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
};

/** Request-scoped client for middleware (cookies flow request -> response). */
export const createMediaRequestClient = (request: NextRequest) => {
  const env = mediaAuthEnv();
  let response = NextResponse.next({ request });
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
export const createMediaCookieClient = () => {
  const env = mediaAuthEnv();
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
