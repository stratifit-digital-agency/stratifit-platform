import { type NextRequest } from "next/server";
import { createMediaRequestClient } from "@/lib/supabase-server";

/**
 * Media session REFRESH middleware (Stage 2.14 D2.14-3).
 *
 * Media is a PUBLIC audience app: this middleware makes NO routing decisions
 * and never gates or redirects. It exists only so the Supabase session
 * cookies carried by authenticated audience users are refreshed in-flight
 * (expired access tokens rotate before resolveAudienceIdentity reads them).
 * Audience identity resolution and every authorization decision remain
 * server-side in services/identity and the pure @stratifit/auth rule.
 */
export async function middleware(request: NextRequest) {
  const { client, getResponse } = createMediaRequestClient(request);
  // Refreshing the session cookies; the result is deliberately unused —
  // anonymous visitors stay fully functional (public content requires no
  // user record).
  await client.auth.getUser();
  return getResponse();
}

export const config = {
  matcher: [
    // Refresh on app routes + the audience-private API family; skip static
    // assets and the callback/login routes themselves.
    "/((?!_next/static|_next/image|favicon.ico|api/health|auth/callback|login).*)",
  ],
};
