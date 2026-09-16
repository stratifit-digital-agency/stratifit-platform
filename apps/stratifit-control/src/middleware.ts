import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth gate for the internal Control app.
 *
 * In the foundation phase there is no live identity provider, so the gate
 * runs in "checkpoint" mode: it documents and reserves the enforcement point.
 * When live Supabase auth is wired (later phase), a missing/invalid session
 * redirects to the operator login; nothing else about the app changes.
 *
 * NOTE: middleware can only make routing decisions. Real authorization is
 * enforced server-side in routes/services (never by client code).
 */
export function middleware(_request: NextRequest) {
  // TODO(auth-wiring): verify operator session via Supabase; redirect to
  // /login when absent. Kept permissive in the foundation so the shell is
  // reviewable without credentials.
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
