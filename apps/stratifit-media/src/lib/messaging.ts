import {
  createMessagingService,
  createDrizzleMessagingRepository,
  createFixedWindowRateLimiter,
  toAudienceConversationView,
  toAudienceMessageView,
  type AudienceConversationView,
  type AudienceMessageView,
  type MessagingAudiencePrincipal,
  type MessagingResult,
} from "@stratifit/messaging";

/**
 * Durable audience messaging for the Media BFF (Stage 2.17).
 *
 * Replaces the Stage-2.1 placeholder (`conv-${Date.now()}` fake conversation
 * ids) with the REAL services/messaging domain behind the approved seam:
 *
 *  - The MessagingAudiencePrincipal is ALWAYS server-derived from the
 *    authenticated session identity (lib/identity.ts): audienceUserId from
 *    the JIT-provisioned audience_users row, emailVerified from the
 *    server-side mirror. No client field ever reaches the service.
 *  - Email verification is enforced twice: by the pure authorizeAudienceAction
 *    rule at this BFF boundary (unchanged) and fail-closed inside the service.
 *  - Creator resolution (handle → ACTIVE creator profile) happens SERVER-SIDE
 *    through the narrow People seam; unknown/inactive handles return not_found
 *    with NO existence leak.
 *  - The D2.17-9 rate limiter (10 sends / 60s per audience user, shared
 *    budget across new conversations and replies) is wired here in-process.
 *  - NO audit writer is configured in this composition: Media cannot perform
 *    audited (operator) mutations at all — the repository fails closed on
 *    appendAudit (D2.4-1). Audience sends carry no audit rows by design.
 *  - Views are whitelisted projections ONLY (toAudience*View): org ids,
 *    operator identities, lead/assignment/takeover internals never cross.
 */

const repository = createDrizzleMessagingRepository({
  databaseUrl: process.env.DATABASE_URL as string,
});

/** ONE shared service instance over the shared repository + limiter. */
const service = createMessagingService({
  repository,
  rateLimiter: createFixedWindowRateLimiter(),
});

/** Build the server-derived audience principal from the resolved identity. */
export const principalOf = (identity: { userId: string; emailVerified: boolean }): MessagingAudiencePrincipal => ({
  kind: "audience",
  audienceUserId: identity.userId,
  emailVerified: identity.emailVerified,
});

/** §13 error mapping for audience messaging outcomes. */
export const audienceError = (
  reason: string,
  message: string,
): { code: string; status: number; message: string } => {
  switch (reason) {
    case "unauthorized":
      // Service-side email-verification gate (mirror of the BFF rule).
      return { code: "email_verification_required", status: 403, message };
    case "not_found":
    case "cross_org_reference":
      // Foreign-owner and cross-org targets are indistinguishable (IDOR-safe).
      return { code: "not_found", status: 404, message: "conversation not found" };
    case "rate_limited":
      return { code: "rate_limited", status: 429, message };
    case "invalid_input":
      return { code: "validation_error", status: 400, message };
    case "invalid_status_transition":
    case "inactive_parent":
      return { code: "domain_rule_violation", status: 422, message };
    default:
      return { code: "internal_error", status: 500, message: "unexpected domain rejection" };
  }
};

/** Flatten a service result into the BFF outcome shape. */
export const flatten = <T,>(
  result: MessagingResult<T>,
): { ok: true; value: T } | { ok: false; code: string; status: number; message: string } =>
  result.ok
    ? { ok: true, value: result.value }
    : { ok: false, ...audienceError(result.error.reason, result.error.message) };

// ---------------------------------------------------------------------------
// Command wrappers (thin — route files stay adapters)
// ---------------------------------------------------------------------------

export const sendFirstMessage = (
  principal: MessagingAudiencePrincipal,
  input: { readonly creatorHandle: string; readonly body: string; readonly subject?: string },
) => service.sendMessage(principal, input);

export const listMyConversations = (principal: MessagingAudiencePrincipal, input: { readonly limit?: number } = {}) =>
  service.listOwnConversations(principal, input);

export const getMyConversation = (principal: MessagingAudiencePrincipal, conversationId: string) =>
  service.getOwnConversation(principal, conversationId);

export const replyToMyConversation = (
  principal: MessagingAudiencePrincipal,
  input: { readonly conversationId: string; readonly body: string },
) => service.replyOwn(principal, input);

export const markMyConversationRead = (
  principal: MessagingAudiencePrincipal,
  input: { readonly conversationId: string; readonly messageId?: string },
) => service.markOwnRead(principal, input);

// ---------------------------------------------------------------------------
// Whitelisted projections (the ONLY shapes the routes serialize)
// ---------------------------------------------------------------------------

export { toAudienceConversationView, toAudienceMessageView };
export type { AudienceConversationView, AudienceMessageView };
