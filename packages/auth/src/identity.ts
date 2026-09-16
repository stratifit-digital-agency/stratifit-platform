/**
 * Identity model (not yet wired to live Supabase).
 *
 * Two strictly separated identity kinds:
 *  - OperatorIdentity: authorized internal users of Stratifit Control.
 *  - AudienceIdentity: public users of Stratifit Media; audience, not producers.
 *
 * Authorization decisions are always derived server-side from server-provided
 * session data. Nothing here trusts client-supplied claims.
 */

export type OperatorRole = "admin" | "operator" | "reviewer" | "viewer";

export interface OperatorIdentity {
  readonly kind: "operator";
  readonly userId: string;
  readonly email: string;
  readonly roles: readonly OperatorRole[];
}

export interface AudienceIdentity {
  readonly kind: "audience";
  readonly userId: string;
  readonly email: string;
  /** Server-derived: Supabase `email_confirmed_at` presence, never a client flag. */
  readonly emailVerified: boolean;
}

export type Identity = OperatorIdentity | AudienceIdentity;

/**
 * Server-side rule: email verification gates commenting, sharing, and
 * messaging for audience users. Additional verification requirements must be
 * introducible later without redesigning the social system, so checks funnel
 * through this single decision function.
 */
export type VerificationRequirement = "email";

export type SocialCapabilityAction = "comment" | "share" | "message" | "like" | "follow" | "save";

const REQUIREMENTS: Record<SocialCapabilityAction, readonly VerificationRequirement[]> = {
  comment: ["email"],
  share: ["email"],
  message: ["email"],
  like: [],
  follow: [],
  save: [],
};

export const verificationRequirementsFor = (
  action: SocialCapabilityAction,
): readonly VerificationRequirement[] => REQUIREMENTS[action];

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: "email_verification_required" | "not_authenticated" };

/** Pure, server-side decision for audience social actions. */
export const authorizeAudienceAction = (
  identity: AudienceIdentity | null,
  action: SocialCapabilityAction,
): AuthorizationDecision => {
  if (!identity) return { allowed: false, reason: "not_authenticated" };
  const requirements = verificationRequirementsFor(action);
  if (requirements.includes("email") && !identity.emailVerified) {
    return { allowed: false, reason: "email_verification_required" };
  }
  return { allowed: true };
};

/**
 * Placeholder Supabase client factory for the later wiring phase.
 * Kept out of any browser bundle; Media never imports production internals
 * and this module never embeds secrets.
 */
export const createSupabaseClientStub = (): { wired: false } => ({ wired: false });
