/**
 * Identity resolution (CD-1 semantics, approved).
 *
 * resolveIdentity        — internal: operator context first, then audience.
 * resolveAudienceIdentity — public fragment path: audience only; operator
 *                           subjects NEVER get audience rows (invariant 12).
 *
 * Operators are never JIT-provisioned (runbook, OQ-4). Audience subjects are
 * JIT-upserted on first resolution (CD-1); authentication and email
 * verification remain separate states — an unverified user resolves non-null
 * and is gated later by authorizeAudienceAction.
 */
import { capabilitiesFor } from "@stratifit/permissions";
import type { AudienceIdentity } from "@stratifit/auth";
import type {
  IdentityRepository,
  OperatorIdentityContext,
  ResolutionResult,
  SessionVerifier,
} from "./types";

export interface IdentityService {
  resolveIdentity(sessionRef: string | null | undefined): Promise<ResolutionResult>;
  resolveAudienceIdentity(sessionRef: string | null | undefined): Promise<AudienceIdentity | null>;
}

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

    // Invariant 12: an operator subject is never provisioned as audience.
    const operator = await repository.findOperatorBySubject(session.subject);
    if (operator) return null;

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

      const operator = await repository.findOperatorBySubject(session.subject);
      if (operator) {
        return {
          identity: {
            kind: "operator",
            userId: operator.id,
            email: operator.email,
            roles: operator.roles,
          },
          organizationId: operator.orgId,
          roles: operator.roles,
          capabilities: capabilitiesFor(operator.roles),
        } satisfies OperatorIdentityContext;
      }

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
    },

    resolveAudienceIdentity,
  };
};
