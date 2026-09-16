/**
 * Identity service ports (no vendor or database imports here).
 *
 * packages/auth supplies the identity TYPES and authorization RULES (D3:
 * packages/auth remains a pure rules layer). This service owns durable state
 * and session verification behind these injectable ports.
 */
import type {
  AudienceIdentity,
  Identity,
  OperatorIdentity,
  OperatorRole,
} from "@stratifit/auth";
import type { ControlCapability } from "@stratifit/permissions";

/** Opaque session reference extracted server-side from a request (cookie/bearer). */
export type SessionRef = string;

/** Result of verifying a session with the credential issuer (Supabase Auth). */
export interface VerifiedSession {
  readonly subject: string;
  readonly email: string | null;
  /** Server-derived from provider state (email_confirmed_at); never a client claim. */
  readonly emailVerified: boolean;
}

/** Port over the credential issuer. Implementations are server-side only. */
export interface SessionVerifier {
  verify(sessionRef: SessionRef): Promise<VerifiedSession | null>;
}

/** Operator identity enriched with tenancy + authorization context. */
export interface OperatorIdentityContext {
  readonly identity: OperatorIdentity;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
}

export type ResolvedIdentity = OperatorIdentityContext | AudienceIdentity;

export type ResolutionResult = ResolvedIdentity | null;

/** Durable identity state port (implemented with @stratifit/database internally). */
export interface IdentityRepository {
  findOperatorBySubject(subject: string): Promise<
    | {
        id: string;
        orgId: string;
        email: string;
        displayName: string | null;
        roles: readonly OperatorRole[];
      }
    | null
  >;
  findAudienceBySubject(
    subject: string,
  ): Promise<{ id: string; orgId: string; email: string | null; emailVerified: boolean } | null>;
  upsertAudienceUser(input: {
    authSubjectRef: string;
    email: string | null;
    emailVerified: boolean;
  }): Promise<{ id: string; orgId: string; email: string | null; emailVerified: boolean }>;
}

/** Identity kinds re-exported for consumers (single source: @stratifit/auth). */
export type { AudienceIdentity, Identity, OperatorIdentity };
