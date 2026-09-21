/**
 * Rights & Consent domain service types (Stage 2.21, D2.21-1..D2.21-8).
 *
 * services/rights owns bounded context 5 (DM section 11):
 *
 *   rights_owners → rights_grants → rights_status_events (immutable history)
 *
 * HARD BOUNDARIES (frozen):
 *  - D2.21-1: v1 subject kinds EXACTLY digital_human|character|persona|
 *    asset|production — `voice` EXCLUDED pending DM Open Question 1.
 *  - D2.21-2: the Publishing (PublicationRightsPort) and People
 *    (PeopleRightsPort) seams remain UNWIRED — this stage ships the adapters
 *    + evaluation seam ONLY; Production gates / Publishing approval / People
 *    authoring / QC behavior are unchanged (ports stay vacuous-pass).
 *  - D2.21-3: NO rights.* events — rights_status_events is the history of
 *    record; taxonomy stays 36.
 *  - D2.21-4: rights.manage (writes) / rights.read (reads) capability family.
 *  - D2.21-5: lifecycle draft → active → suspended ⇄ active → revoked;
 *    active/suspended → expired; revoked + expired TERMINAL. `expired` is an
 *    explicit operator command in this stage; evaluation is LAZY (validity
 *    windows evaluated at use time) — no worker/queue/Redis.
 *  - D2.21-6: grant CORE fields immutable through the service API — status
 *    transitions only; grants are never deleted.
 *  - D2.21-8: four frozen audit actions, same-transaction (D2.4-1).
 */
import type { ControlCapability } from "@stratifit/permissions";

// ---------------------------------------------------------------------------
// Frozen vocabularies (DB CHECK mirrors)
// ---------------------------------------------------------------------------

/** D2.21-1: v1 subject kinds — voice EXCLUDED (DM OQ1 open). */
export const RIGHTS_SUBJECT_KINDS = ["digital_human", "character", "persona", "asset", "production"] as const;
export type RightsSubjectKind = (typeof RIGHTS_SUBJECT_KINDS)[number];

/** DM §11 usage categories. */
export const RIGHTS_SCOPES = ["generation", "publication", "advertising", "messaging", "derivative_creation"] as const;
export type RightsScope = (typeof RIGHTS_SCOPES)[number];

/** DM §11 platform targets (DB CHECK allowlist mirror). */
export const RIGHTS_PLATFORMS = ["stratifit_media", "youtube", "tiktok", "instagram", "facebook", "all"] as const;
export type RightsPlatform = (typeof RIGHTS_PLATFORMS)[number];

/** Grant lifecycle (D2.21-5). */
export const GRANT_STATUSES = ["draft", "active", "expired", "revoked", "suspended"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

/** Owner verification states (DB CHECK mirror). */
export const OWNER_VERIFICATION_STATUSES = ["unverified", "pending", "verified", "rejected"] as const;
export type OwnerVerificationStatus = (typeof OWNER_VERIFICATION_STATUSES)[number];

export type OwnerKind = "individual" | "organization";

// ---------------------------------------------------------------------------
// Records (service-internal, mirror the Drizzle rows)
// ---------------------------------------------------------------------------

export interface RightsOwnerRecord {
  readonly id: string;
  readonly orgId: string;
  readonly kind: OwnerKind;
  readonly displayName: string;
  readonly contactRef: string | null;
  readonly verificationStatus: OwnerVerificationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RightsGrantRecord {
  readonly id: string;
  readonly orgId: string;
  readonly ownerId: string;
  readonly subjectKind: RightsSubjectKind;
  readonly subjectId: string;
  readonly scope: RightsScope;
  readonly platforms: readonly RightsPlatform[];
  readonly territories: readonly string[];
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly status: GrantStatus;
  readonly grantedBy: string;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RightsStatusEventRecord {
  readonly id: string;
  readonly orgId: string;
  readonly grantId: string;
  readonly fromStatus: GrantStatus;
  readonly toStatus: GrantStatus;
  readonly reason: string | null;
  readonly actorId: string;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Same-transaction audit seam (D2.4-1 reused) + FROZEN audit actions
// ---------------------------------------------------------------------------

export type RightsAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "rights_owner" | "rights_grant";
  targetId: string;
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}) => Promise<void>;

export interface RightsAuditWriter {
  appendWithin(tx: unknown, entry: Parameters<RightsAuditAppend>[0]): Promise<void>;
}

/** FROZEN audit actions (Stage 2.21, D2.21-8): exactly these four. */
export const RIGHTS_AUDIT_ACTIONS = [
  "rights.owner_created",
  "rights.owner_status_changed",
  "rights.grant_created",
  "rights.grant_status_changed",
] as const;

// ---------------------------------------------------------------------------
// Command results (house style: discriminated, never throws)
// ---------------------------------------------------------------------------

export type RightsErrorReason =
  | "unauthorized"
  | "not_found"
  | "cross_org_reference"
  | "inactive_parent"
  | "invalid_status_transition"
  | "invalid_input";

export type RightsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly reason: RightsErrorReason; readonly message: string } };

export const ok = <T>(value: T): RightsResult<T> => ({ ok: true, value });
export const err = <T>(reason: RightsErrorReason, message: string): RightsResult<T> => ({
  ok: false,
  error: { reason, message },
});

// ---------------------------------------------------------------------------
// Repository port (implemented by the Drizzle adapter in repository.ts)
// ---------------------------------------------------------------------------

export interface RightsRepository {
  runInTransaction<T>(work: (tx: RightsTransaction) => Promise<T>): Promise<T>;

  // reads (org-scoped; pool-level)
  findOwnerById(id: string): Promise<RightsOwnerRecord | null>;
  listOwners(orgId: string, limit: number): Promise<readonly RightsOwnerRecord[]>;
  setOwnerVerificationStatus(
    id: string,
    status: OwnerVerificationStatus,
  ): Promise<RightsOwnerRecord | null>;
  findGrantById(id: string): Promise<RightsGrantRecord | null>;
  findGrantBySubject(
    orgId: string,
    subjectKind: RightsSubjectKind,
    subjectId: string,
    scope: RightsScope,
  ): Promise<readonly RightsGrantRecord[]>;
  listGrants(orgId: string, limit: number): Promise<readonly RightsGrantRecord[]>;
  listStatusEvents(grantId: string): Promise<readonly RightsStatusEventRecord[]>;
  setStatusEvent(as: { event: Omit<RightsStatusEventRecord, "id" | "createdAt"> }): Promise<RightsStatusEventRecord>;

  // direct mutations (test-only sequential fallback)
  insertOwner(input: {
    orgId: string;
    kind: OwnerKind;
    displayName: string;
    contactRef: string | null;
  }): Promise<RightsOwnerRecord>;
  insertGrant(input: {
    orgId: string;
    ownerId: string;
    subjectKind: RightsSubjectKind;
    subjectId: string;
    scope: RightsScope;
    platforms: readonly RightsPlatform[];
    territories: readonly string[];
    startsAt: Date | null;
    expiresAt: Date | null;
    grantedBy: string;
    evidenceRefs: readonly string[];
    status: GrantStatus;
  }): Promise<RightsGrantRecord>;
  setGrantStatus(id: string, status: GrantStatus): Promise<RightsGrantRecord | null>;
  insertStatusEvent(input: {
    orgId: string;
    grantId: string;
    fromStatus: GrantStatus;
    toStatus: GrantStatus;
    reason: string | null;
    actorId: string;
  }): Promise<RightsStatusEventRecord>;
}

/**
 * Transaction-scoped persistence + audit append (D2.4-1, reused): every
 * security-critical mutation, its status-event row, and its audit record run
 * on the SAME database transaction.
 */
export interface RightsTransaction {
  findOwnerById(id: string): Promise<RightsOwnerRecord | null>;
  findGrantById(id: string): Promise<RightsGrantRecord | null>;
  /**
   * Subject-integrity seam (read-only, no Production/Generation/People/QC
   * behavior change): returns the minimal same-org facts for a referenced
   * subject row, or null when absent. Implemented per-kind against the
   * existing tables (digital_humans/characters/personas/assets/productions).
   */
  findSubjectRef(
    subjectKind: RightsSubjectKind,
    subjectId: string,
  ): Promise<{ readonly id: string; readonly orgId: string; readonly status: string } | null>;
  insertOwner(input: {
    orgId: string;
    kind: OwnerKind;
    displayName: string;
    contactRef: string | null;
  }): Promise<RightsOwnerRecord>;
  setOwnerVerificationStatus(
    id: string,
    status: OwnerVerificationStatus,
  ): Promise<RightsOwnerRecord | null>;
  insertGrant(input: {
    orgId: string;
    ownerId: string;
    subjectKind: RightsSubjectKind;
    subjectId: string;
    scope: RightsScope;
    platforms: readonly RightsPlatform[];
    territories: readonly string[];
    startsAt: Date | null;
    expiresAt: Date | null;
    grantedBy: string;
    evidenceRefs: readonly string[];
    status: GrantStatus;
  }): Promise<RightsGrantRecord>;
  setGrantStatus(id: string, status: GrantStatus): Promise<RightsGrantRecord | null>;
  insertStatusEvent(input: {
    orgId: string;
    grantId: string;
    fromStatus: GrantStatus;
    toStatus: GrantStatus;
    reason: string | null;
    actorId: string;
  }): Promise<RightsStatusEventRecord>;
  appendAudit(entry: Parameters<RightsAuditAppend>[0]): Promise<void>;
}

/** Server-derived Control operator principal (identity-resolved, no client authority). */
export interface RightsPrincipal {
  readonly operatorId: string;
  readonly orgId: string;
  readonly capabilities: readonly ControlCapability[];
}

// ---------------------------------------------------------------------------
// Inputs (org/actor are NEVER inputs — server-derived principal only)
// ---------------------------------------------------------------------------

export interface CreateOwnerInput {
  readonly kind: OwnerKind;
  readonly displayName: string;
  readonly contactRef?: string | null;
}

/** Owner verification-status change (operator command). */
export type OwnerVerificationInput = { readonly id: string; readonly status: OwnerVerificationStatus };

export interface CreateGrantInput {
  readonly ownerId: string;
  readonly subjectKind: RightsSubjectKind;
  readonly subjectId: string;
  readonly scope: RightsScope;
  readonly platforms: readonly RightsPlatform[];
  readonly territories: readonly string[];
  readonly startsAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly evidenceRefs?: readonly string[];
}

export type GrantStatusInput = { readonly id: string; readonly status: GrantStatus; readonly reason?: string | null };

// ---------------------------------------------------------------------------
// Evaluation seam (D2.21-2: exported, UNWIRED — fail-closed, lazy windows)
// ---------------------------------------------------------------------------

/** One structured reason why a required right is not satisfied. */
export interface UnsatisfiedReason {
  readonly code:
    | "grant_not_found"
    | "grant_not_active"
    | "validity_window"
    | "scope_mismatch"
    | "platform_mismatch"
    | "territory_mismatch";
  readonly message: string;
  readonly grantId?: string;
}

export interface UseRequest {
  readonly orgId: string;
  readonly subjectKind: RightsSubjectKind;
  readonly subjectId: string;
  readonly scope: RightsScope;
  readonly platform: RightsPlatform;
  readonly territory: string;
  /** Evaluation instant (lazy time-window evaluation, D2.21-5). */
  readonly at: Date;
}

export interface UseEvaluation {
  readonly satisfied: boolean;
  readonly grantId?: string;
  readonly reasons: readonly UnsatisfiedReason[];
}

/** Repository read used by the evaluator (candidate grants for the subject/scope). */
export type GrantLookup = (
  orgId: string,
  subjectKind: RightsSubjectKind,
  subjectId: string,
  scope: RightsScope,
) => Promise<readonly RightsGrantRecord[]>;

export interface RightsServiceDeps {
  readonly repository: RightsRepository;
}

export interface RightsService {
  // ---- Control authoring (rights.manage) --------------------------------
  createOwner(principal: RightsPrincipal, input: CreateOwnerInput): Promise<RightsResult<RightsOwnerRecord>>;
  changeOwnerVerification(
    principal: RightsPrincipal,
    input: OwnerVerificationInput,
  ): Promise<RightsResult<RightsOwnerRecord>>;
  createGrant(principal: RightsPrincipal, input: CreateGrantInput): Promise<RightsResult<RightsGrantRecord>>;
  changeGrantStatus(principal: RightsPrincipal, input: GrantStatusInput): Promise<RightsResult<RightsGrantRecord>>;

  // ---- Reads (rights.read) ----------------------------------------------
  listOwners(principal: RightsPrincipal, limit?: number): Promise<RightsResult<readonly RightsOwnerRecord[]>>;
  listGrants(principal: RightsPrincipal, limit?: number): Promise<RightsResult<readonly RightsGrantRecord[]>>;
  getGrant(principal: RightsPrincipal, id: string): Promise<RightsResult<{ grant: RightsGrantRecord; history: readonly RightsStatusEventRecord[] }>>;

  // ---- Evaluation (pure function over the repository; UNWIRED elsewhere) --
  evaluateUse(request: UseRequest): Promise<UseEvaluation>;
}
