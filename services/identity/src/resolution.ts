/**
 * Identity resolution (CD-1 semantics, approved; Stage 2.2 authorization).
 *
 * resolveIdentity        — internal: operator context first, then audience.
 * resolveAudienceIdentity — public fragment path: audience only; operator
 *                           subjects NEVER get audience rows (invariant 12).
 *
 * Stage 2.2 (approved decisions D-1/D-2):
 *  - Authorization derives SOLELY from active org memberships (org_memberships
 *    role). `operators.roles` is deprecated metadata and is never consulted.
 *  - FAIL-CLOSED: an operator resolves to null (never an audience row, never
 *    an under-privileged context) when the operator row, the organization, or
 *    the org membership is missing, suspended, inactive, or archived.
 *  - Operators are never JIT-provisioned (runbook, OQ-4). Audience subjects
 *    are JIT-upserted on first resolution (CD-1); authentication and email
 *    verification remain separate states — an unverified user resolves
 *    non-null and is gated later by authorizeAudienceAction.
 */
import { capabilitiesFor } from "@stratifit/permissions";
import type { AudienceIdentity, OperatorRole } from "@stratifit/auth";
import type {
  IdentityRepository,
  OperatorAuthorizationLookup,
  OperatorIdentityContext,
  ResolutionResult,
  SessionVerifier,
} from "./types";

export interface IdentityService {
  resolveIdentity(sessionRef: string | null | undefined): Promise<ResolutionResult>;
  resolveAudienceIdentity(sessionRef: string | null | undefined): Promise<AudienceIdentity | null>;
}

export type OperatorAuthorizationDecision =
  | { allowed: true; organizationId: string; roles: readonly OperatorRole[] }
  | { allowed: false; reason: string };

/**
 * Pure fail-closed authorization decision (D-2): every element must be
 * positively active, or the operator is denied. Unknown statuses deny.
 */
export const authorizeOperator = (
  lookup: OperatorAuthorizationLookup,
): OperatorAuthorizationDecision => {
  if (lookup.operatorStatus !== "active") return { allowed: false, reason: "operator_not_active" };
  if (lookup.organizationStatus !== "active") {
    return { allowed: false, reason: `organization_${lookup.organizationStatus}` };
  }
  const m = lookup.orgMembership;
  if (!m || m.status !== "active") return { allowed: false, reason: "membership_not_active" };
  return { allowed: true, organizationId: lookup.organizationId, roles: [m.role] };
};

export const createIdentityResolution = (deps: {
  sessionVerifier: SessionVerifier;
  repository: IdentityRepository;
}): IdentityService => {
  const { sessionVerifier, repository } = deps;

  const resolveAudienceIdentity = async (
    sessionRef: string | null | undefined,
  ): Promise<AudienceIdentity | null> => {
    if (!sessionRef) return null;
    const session = await sessionVerifier.verify(sessionRef);
    if (!session) return null; // anonymous / invalid / expired -> null (no row)

    // Invariant 12: an operator subject (row exists, regardless of its
    // authorization state) is never provisioned as audience.
    const operatorRow = await repository.findOperatorBySubject(session.subject);
    if (operatorRow) return null;

    const user = await repository.upsertAudienceUser({
      authSubjectRef: session.subject,
      email: session.email,
      emailVerified: session.emailVerified,
    });
    return {
      kind: "audience",
      userId: user.id,
      email: user.email ?? "",
      emailVerified: user.emailVerified,
    };
  };

  return {
    async resolveIdentity(sessionRef) {
      if (!sessionRef) return null;
      const session = await sessionVerifier.verify(sessionRef);
      if (!session) return null;

      const operatorRow = await repository.findOperatorBySubject(session.subject);
      if (!operatorRow) {
        // Unknown subject falls through to the audience path (CD-1).
        const user = await repository.upsertAudienceUser({
          authSubjectRef: session.subject,
          email: session.email,
          emailVerified: session.emailVerified,
        });
        return {
          kind: "audience",
          userId: user.id,
          email: user.email ?? "",
          emailVerified: user.emailVerified,
        };
      }

      // Operator subject: authorization is membership-derived and fail-closed.
      const lookup = await repository.findOperatorAuthorization(operatorRow.id);
      if (!lookup) return null;
      const decision = authorizeOperator(lookup);
      if (!decision.allowed) return null;

      return {
        identity: {
          kind: "operator",
          userId: operatorRow.id,
          email: operatorRow.email,
          roles: decision.roles,
        },
        organizationId: decision.organizationId,
        roles: decision.roles,
        capabilities: capabilitiesFor(decision.roles),
      } satisfies OperatorIdentityContext;
    },

    resolveAudienceIdentity,
  };
};
