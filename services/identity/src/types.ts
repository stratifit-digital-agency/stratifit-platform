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

/**
 * Authorization status of an operator for identity resolution (D-1/D-2).
 *
 * `org_memberships.role` is the SOLE authoritative authorization source.
 * `operators.roles` is deprecated compatibility metadata and is NEVER read
 * for authorization. The authorization lookup is fail-closed: any missing or
 * non-active element resolves to an authorization that DENIES.
 */
export interface OperatorAuthorizationLookup {
  readonly operatorStatus: string;
  readonly organizationId: string;
  readonly organizationStatus: string;
  /** Org-scoped membership carrying the authorization role; null when absent. */
  readonly orgMembership: {
    readonly id: string;
    readonly role: OperatorRole;
    readonly status: string;
  } | null;
}

/** Durable identity state port (implemented with @stratifit/database internally). */
export interface IdentityRepository {
  /**
   * Row lookup regardless of operator status (callers fail closed explicitly,
   * D-2). Returns NO authorization data: roles/org come from memberships.
   */
  findOperatorBySubject(subject: string): Promise<
    | {
        id: string;
        email: string;
        displayName: string | null;
        status: string;
      }
    | null
  >;
  /**
   * Joined authorization facts for the fail-closed decision (D-2): operator
   * status, organization status, and the operator's active-scope org
   * membership. Null when the operator row is missing entirely.
   */
  findOperatorAuthorization(
    operatorId: string,
  ): Promise<OperatorAuthorizationLookup | null>;
  findAudienceBySubject(
    subject: string,
  ): Promise<{ id: string; orgId: string; email: string | null; emailVerified: boolean } | null>;
  upsertAudienceUser(input: {
    authSubjectRef: string;
    email: string | null;
    emailVerified: boolean;
  }): Promise<{ id: string; orgId: string; email: string | null; emailVerified: boolean }>;
}

// ---------------------------------------------------------------------------
// Memberships & teams (Stage 2.2, decisions D-1..D-5)
// ---------------------------------------------------------------------------

export type MembershipStatus = "active" | "inactive" | "suspended" | "revoked";

/** A membership grant record (DM section 6: append-and-revoke, never edited). */
export interface MembershipRecord {
  readonly id: string;
  readonly operatorId: string;
  readonly organizationId: string | null;
  readonly teamId: string | null;
  /** Null iff team-scoped (D-3 structural guarantee). */
  readonly role: OperatorRole | null;
  readonly status: MembershipStatus;
  readonly grantedBy: string | null;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

export interface TeamRecord {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly status: "active" | "archived";
}

/** Server-derived authorization facts a membership command actor must present. */
export interface MembershipActor {
  /** The acting operator's row id (identity.userId at composition roots). */
  readonly operatorId: string;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
}

export type MembershipCommandErrorReason =
  | "missing_capability"
  | "self_grant"
  | "role_escalation"
  | "cross_org"
  | "org_not_active"
  | "team_not_active"
  | "invalid_transition"
  | "invalid_request"
  | "operator_not_found"
  | "operator_not_active"
  | "membership_not_found"
  | "team_not_found"
  | "membership_conflict";

export type MembershipCommandError = {
  readonly reason: MembershipCommandErrorReason;
  readonly message: string;
};

export type MembershipCommandResult< T > =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MembershipCommandError };

/** Durable membership/team state port. */
export interface MembershipRepository {
  findOperatorById(id: string): Promise<{ id: string; orgId: string; status: string } | null>;
  findOrganizationStatus(orgId: string): Promise<string | null>;
  findTeamById(teamId: string): Promise<TeamRecord | null>;
  findTeamBySlug(orgId: string, slug: string): Promise<TeamRecord | null>;
  insertTeam(input: { orgId: string; slug: string; name: string }): Promise<TeamRecord>;
  updateTeamStatus(teamId: string, status: "archived"): Promise<TeamRecord>;
  listTeamsByOrg(orgId: string): Promise<TeamRecord[]>;
  findNonRevokedOrgMembership(
    operatorId: string,
    organizationId: string,
  ): Promise<MembershipRecord | null>;
  findNonRevokedTeamMembership(operatorId: string, teamId: string): Promise<MembershipRecord | null>;
  findMembershipById(id: string): Promise<MembershipRecord | null>;
  insertOrgMembership(input: {
    operatorId: string;
    organizationId?: string;
    teamId?: string;
    role?: OperatorRole;
    grantedBy?: string;
  }): Promise<MembershipRecord>;
  updateMembershipStatus(
    id: string,
    status: MembershipStatus,
    revokedAt: Date | null,
  ): Promise<MembershipRecord>;
  listMembershipsForOrg(orgId: string, includeRevoked: boolean): Promise<MembershipRecord[]>;
  listTeamAssignments(teamId: string, includeRevoked: boolean): Promise<MembershipRecord[]>;
}

/**
 * D4 audit seam (NOT implemented in Stage 2.2). Composition roots inject the
 * admin-audit append; the default is an explicit no-op stub.
 */
export type AuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "membership" | "team";
  targetId: string;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

/** Identity kinds re-exported for consumers (single source: @stratifit/auth). */
export type { AudienceIdentity, Identity, OperatorIdentity };
