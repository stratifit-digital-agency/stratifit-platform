import { createPublicIdentityService, type PublicIdentityService } from "@stratifit/identity/public";
import type { AudienceIdentity } from "@stratifit/auth";

/**
 * Media-side identity resolution — public-safe fragment ONLY.
 *
 * The session reference comes from the request (bearer or cookie), and the
 * audience identity is resolved server-side by services/identity (CD-1:
 * unverified users resolve non-null and are gated downstream by
 * authorizeAudienceAction). Media never imports @stratifit/database and never
 * touches internal identity infrastructure.
 */
let service: PublicIdentityService | null = null;

const getService = (): PublicIdentityService | null => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!url || !anonKey || !databaseUrl) return null;
  if (!service) {
    service = createPublicIdentityService({ url, anonKey, databaseUrl });
  }
  return service;
};

/** Extract a session reference server-side from the request. */
export const sessionRefFromRequest = (request: Request): string | null => {
  const auth = request.headers.get("authorization");
  if (auth) return auth;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)sb-[^=]*-auth-token(?:\.\d+)?=([^;]+)/.exec(cookieHeader);
  const token = match?.[1];
  return token ? decodeURIComponent(token) : null;
};

/** Resolve the current audience identity; null keeps the caller anonymous. */
export const resolveMediaIdentity = async (request: Request): Promise<AudienceIdentity | null> => {
  const svc = getService();
  if (!svc) return null;
  return svc.resolveAudienceIdentity(sessionRefFromRequest(request));
};
