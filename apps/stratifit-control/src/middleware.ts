import { NextResponse, type NextRequest } from "next/server";
import { gateDecision } from "@/lib/gate-decision";
import { createControlRequestClient } from "@/lib/supabase-server";

/**
 * Auth gate for the internal Control app (activated in Stage 2.1).
 *
 * Middleware makes ROUTING DECISIONS only: a missing session redirects to
 * /login; a missing issuer configuration fails closed (503). Identity
 * resolution and real authorization (capability matrix) happen server-side in
 * routes/pages via services/identity — never from client claims
 * (API_ARCHITECTURE section 7).
 */
export async function middleware(request: NextRequest) {
  const env = {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };

  // Fail closed before touching the issuer when configuration is absent.
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    return NextResponse.rewrite(new URL("/login", request.url), { status: 503 });
  }

  const { client, getResponse } = createControlRequestClient(request);
  const {
    data: { user },
  } = await client.auth.getUser();
  const decision = gateDecision({ userId: user?.id ?? null }, env);

  switch (decision.action) {
    case "redirect":
      return NextResponse.redirect(new URL(decision.location, request.url));
    case "fail-closed":
      return NextResponse.rewrite(new URL("/login", request.url), { status: 503 });
    default:
      return getResponse();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|auth/callback|login).*)"],
};
