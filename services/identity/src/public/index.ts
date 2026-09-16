/**
 * PUBLIC-SAFE FRAGMENT of @stratifit/identity (SERVICE_ARCHITECTURE s13).
 *
 * This subpath — and only this subpath — is registered public-safe in the
 * ESLint boundary configuration; Media may import it. It exposes audience
 * resolution only, with structural types and its own connection, so Media
 * never imports @stratifit/database or the internal module surface.
 *
 * The module's internals (operator resolution, repositories, verifier
 * internals) stay internal.
 */
import type { AudienceIdentity } from "@stratifit/auth";
import { createDrizzleIdentityRepository } from "../repository";
import { createIdentityResolution } from "../resolution";
import { createSupabaseSessionVerifier } from "../supabase-session-verifier";

export interface PublicIdentityService {
  resolveAudienceIdentity(sessionRef: string | null | undefined): Promise<AudienceIdentity | null>;
}

export interface CreatePublicIdentityServiceOptions {
  url: string;
  anonKey: string;
  databaseUrl: string;
  defaultOrgSlug?: string;
}

export const createPublicIdentityService = (
  options: CreatePublicIdentityServiceOptions,
): PublicIdentityService => {
  const resolution = createIdentityResolution({
    sessionVerifier: createSupabaseSessionVerifier({ url: options.url, anonKey: options.anonKey }),
    repository: createDrizzleIdentityRepository({
      databaseUrl: options.databaseUrl,
      ...(options.defaultOrgSlug !== undefined ? { defaultOrgSlug: options.defaultOrgSlug } : {}),
    }),
  });
  return { resolveAudienceIdentity: (ref) => resolution.resolveAudienceIdentity(ref) };
};
