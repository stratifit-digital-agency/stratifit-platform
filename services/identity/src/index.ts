/**
 * Internal surface of @stratifit/identity (Control/internal consumers only).
 * The public-safe fragment lives at @stratifit/identity/public.
 */
export { createIdentityResolution, type IdentityService } from "./resolution";
export { createDrizzleIdentityRepository, type DrizzleIdentityRepositoryDeps } from "./repository";
export { createSupabaseSessionVerifier, type SupabaseSessionVerifierOptions } from "./supabase-session-verifier";
export type {
  IdentityRepository,
  OperatorIdentityContext,
  ResolutionResult,
  ResolvedIdentity,
  SessionRef,
  SessionVerifier,
  VerifiedSession,
} from "./types";
