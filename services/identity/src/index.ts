/**
 * Internal surface of @stratifit/identity (Control/internal consumers only).
 * The public-safe fragment lives at @stratifit/identity/public.
 */
export { createIdentityResolution, authorizeOperator, type IdentityService, type OperatorAuthorizationDecision } from "./resolution";
export { createMembershipService, ROLE_ACTION, ROLE_RANK, type MembershipService, type MembershipServiceDeps } from "./membership";
export { createDrizzleIdentityRepository, createDrizzleMembershipRepository, type DrizzleIdentityRepositoryDeps } from "./repository";
export { createSupabaseSessionVerifier, type SupabaseSessionVerifierOptions } from "./supabase-session-verifier";
export type {
  AuditAppend,
  IdentityRepository,
  MembershipActor,
  MembershipCommandError,
  MembershipCommandErrorReason,
  MembershipCommandResult,
  MembershipRecord,
  MembershipRepository,
  MembershipStatus,
  OperatorAuthorizationLookup,
  OperatorIdentityContext,
  ResolutionResult,
  ResolvedIdentity,
  SessionRef,
  SessionVerifier,
  TeamRecord,
  VerifiedSession,
} from "./types";
