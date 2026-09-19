/**
 * Publishing-domain service ports (Stage 2.12, approved plan; D2.12-A..G).
 *
 * services/publishing-engine owns the Publishing bounded context (SVC
 * section 11 context 11): publications, publication_versions,
 * distribution_references. No database imports here — this module declares
 * the injectable ports; the Drizzle adapter implements them. Cross-module
 * subjects (production, asset_version, ai_creator_profile,
 * campaign_creative) stay LOOSE references (approved D2.12-D): there are NO
 * cross-context foreign keys.
 *
 * HARD FAILURE-ISOLATION RULE (DM invariant 5): publication failure NEVER
 * invalidates the underlying master asset/production. This service owns
 * ONLY Publishing state — it has no Asset/Generation/Production mutation
 * dependency at all.
 *
 * D2.12-A RIGHTS SEAM: rights requirements are resolved through a narrow
 * port. In Stage 2.12 the composition root supplies a port that always
 * returns { declared: false } — absence of declared rights requirements is
 * a VACUOUS PASS. When Rights/Consent becomes durable, the adapter swap
 * turns this port into a blocking prerequisite without touching this
 * module's logic.
 */
import type { ControlCapability } from "@stratifit/permissions";

/** Operator authorization role (mirrors @stratifit/auth OperatorRole). */
export type OperatorRole = "admin" | "operator" | "reviewer" | "viewer";

/** D2.12-D: the four publication subject kinds. */
export type PublicationSubjectKind =
  | "production"
  | "asset_version"
  | "ai_creator_profile"
  | "campaign_creative";

/** Stage-1 platform targets (the local platform first; externals later). */
export type PlatformTarget = "stratifit-media" | "youtube" | "tiktok" | "instagram" | "facebook";

/** D2.12-B: the narrow Stage-1 content taxonomy (expands with the public content model later). */
export type PublicationContentType = "film" | "series" | "episode" | "short" | "music" | "documentary" | "trailer";

/** D2.12-C: the COMPLETE DM section 32.6 publication lifecycle. */
export type PublicationStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "unpublished"
  | "failed";

/** Terminal states have NO outgoing edges (DM section 32.6).
 *  `unpublished` is terminal; `failed` is terminal once retry attempts are
 *  exhausted (service-level maxPublishAttempts rule). */
export const TERMINAL_PUBLICATION_STATUSES: readonly PublicationStatus[] = ["unpublished"];

/**
 * The approved DM section 32.6 state machine. Legal edges ONLY.
 * CRITICAL (approved correction): publish() is valid ONLY from `scheduled`
 * — `approved → publishing` is forbidden; the only path out of `approved`
 * is schedule(). Failure: publishing → failed; retry: failed →
 * pending_approval (same version re-delivered).
 */
export const PUBLICATION_TRANSITIONS: Readonly<Record<PublicationStatus, readonly PublicationStatus[]>> = {
  draft: ["pending_approval"],
  pending_approval: ["approved"],
  approved: ["scheduled"],
  scheduled: ["publishing"],
  publishing: ["published", "failed"],
  published: ["unpublished"],
  unpublished: [],
  failed: ["pending_approval"],
};

/**
 * Server-derived authorization facts a Publishing command actor must
 * present. organizationId is ALWAYS the org authority; clients can never
 * supply one.
 */
export interface PublicationActor {
  /** The acting operator's row id; null ONLY for execution/service actors. */
  readonly operatorId: string | null;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
  /** Optional correlation id propagated into audit records. */
  readonly correlationId?: string | null;
}

// ---------------------------------------------------------------------------
// Narrow read-only upstream subject-validation ports (D2.12-D). Structural:
// composition roots satisfy them with the Stage 2.6/2.10 repositories. They
// expose org-scoped lookups ONLY — Publishing never gains mutation access to
// any upstream family. ai_creator_profile / campaign_creative subjects are
// structurally supported but FAIL CLOSED until their bounded contexts exist.
// ---------------------------------------------------------------------------

/** Production mirror of the Stage 2.6 productions row (org-scoped). */
export interface PublicationSubjectProduction {
  readonly id: string;
  readonly orgId: string;
  readonly status: string;
}

export interface PublicationProductionPort {
  findProductionById(orgId: string, productionId: string): Promise<PublicationSubjectProduction | null>;
}

/** Asset-version mirror of the Stage 2.10 asset_versions row (org-scoped). */
export interface PublicationSubjectAssetVersion {
  readonly id: string;
  readonly orgId: string;
}

export interface PublicationAssetVersionPort {
  findAssetVersionById(orgId: string, assetVersionId: string): Promise<PublicationSubjectAssetVersion | null>;
}

/** Resolved subject facts (unsupported kinds resolve to `unsupported` → fail closed). */
export type ResolvedPublicationSubject =
  | { readonly kind: "production"; readonly production: PublicationSubjectProduction }
  | { readonly kind: "asset_version"; readonly assetVersion: PublicationSubjectAssetVersion }
  | {
      readonly kind: "ai_creator_profile" | "campaign_creative";
      readonly unsupported: true;
    };

/**
 * D2.12-D subject-resolution port: returns the resolved subject when it
 * exists inside the requesting organization; ai_creator_profile /
 * campaign_creative return the `unsupported` variant (FAIL CLOSED — their
 * bounded contexts do not exist yet); a cross-org or absent subject returns
 * null (IDOR-safe).
 */
export type PublicationResolvedSubjectPort = (
  orgId: string,
  subjectKind: PublicationSubjectKind,
  subjectRef: string,
) => Promise<ResolvedPublicationSubject | null>;

// ---------------------------------------------------------------------------
// Narrow QC-eligibility and rights ports (plan sections 9 and 11)
// ---------------------------------------------------------------------------

/**
 * QC handoff (plan section 9): the composition root implements this port by
 * reading the subject's durable QC review state and evaluating it with the
 * established PURE evaluatePublicationEligibility function from the QC
 * module. Publishing consumes ONLY the verdict — it never duplicates QC
 * rules and never imports QC mutation surfaces (zero QC→Asset coupling is
 * preserved; the EVENT_ARCHITECTURE "qc.requested → asset.approved"
 * documentation debt is NOT implemented here either).
 *
 * Returns null when no QC review exists for the subject (fail closed).
 */
export type PublicationEligibilityPort = (
  orgId: string,
  subjectKind: PublicationSubjectKind,
  subjectRef: string,
) => Promise<{ readonly eligible: boolean; readonly reasons: readonly string[] } | null>;

/**
 * D2.12-A rights seam: OPTIONAL. Stage 2.12 composition roots leave this
 * port UNWIRED (undefined) — absence of a port means absence of declared
 * rights requirements, i.e. a VACUOUS PASS. A future Rights stage may
 * inject an adapter returning declared requirements; when it does,
 * Publishing treats unmet requirements as blocking (approval gate only)
 * without any change to the state machine.
 */
export type PublicationRightsPort = (
  orgId: string,
  subjectKind: PublicationSubjectKind,
  subjectRef: string,
) => Promise<{ readonly declared: boolean; readonly met: boolean; readonly reasons?: readonly string[] }>;

// ---------------------------------------------------------------------------
// Platform adapter boundary (D2.12-F: operator-initiated synchronous
// delivery through the LOCAL stratifit-media adapter only in this stage; no
// provider credentials, no external network execution, no delivery workers)
// ---------------------------------------------------------------------------

/** Publishable payload handed to a platform adapter — public-safe fields ONLY. */
export interface PublicationDeliveryPayload {
  readonly publicationId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly synopsis: string | null;
  readonly contentType: PublicationContentType;
  readonly platformTarget: PlatformTarget;
}

export interface PublicationPlatformAdapter {
  readonly target: PlatformTarget;
  publish(payload: PublicationDeliveryPayload): Promise<{ externalId: string }>;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface PublicationRecordView {
  readonly id: string;
  readonly orgId: string;
  readonly subjectKind: PublicationSubjectKind;
  readonly subjectRef: string;
  readonly platformTarget: PlatformTarget;
  readonly contentType: PublicationContentType;
  readonly currentVersionId: string | null;
  /** Approval-time QC review reference (stamped by approve; null until then). */
  readonly qcReviewId: string | null;
  readonly status: PublicationStatus;
  readonly scheduledFor: string | null;
  readonly attemptCount: number;
  readonly lastFailureReason: string | null;
  readonly lastAttemptAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Immutable publication version snapshot (EXACT frozen Stage 2.12 shape). */
export interface PublicationVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly publicationId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly synopsis: string | null;
  readonly contentType: PublicationContentType;
  readonly subjectKind: PublicationSubjectKind;
  readonly subjectRef: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/** Immutable distribution attempt record. */
export interface DistributionReferenceRecord {
  readonly id: string;
  readonly orgId: string;
  readonly publicationId: string;
  readonly versionId: string;
  readonly platformTarget: PlatformTarget;
  readonly externalRef: string | null;
  /** FROZEN outcome enum: delivered | failed (never 'succeeded'). */
  readonly deliveryOutcome: "delivered" | "failed";
  readonly failureReason: string | null;
  readonly createdAt: string;
}

export type PublishingCommandErrorReason =
  | "missing_capability"
  | "cross_org"
  | "publication_not_found"
  | "subject_not_found"
  | "subject_unsupported"
  | "invalid_request"
  | "invalid_transition"
  | "gate_not_approved"
  | "rights_requirements_unmet"
  | "adapter_not_found"
  | "max_attempts_exhausted"
  | "publication_conflict"
  | "conflict";

export type PublishingCommandError = {
  readonly reason: PublishingCommandErrorReason;
  readonly message: string;
};

export type PublishingCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PublishingCommandError };

/**
 * Audit entry accepted by the sanctioned admin-audit seam (D2.4-1 reused;
 * composition roots map it to admin-audit's canonical entry).
 */
export type PublishingAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "publication" | "publication_version" | "distribution_reference";
  targetId: string;
  /** Org scope for organization-scoped audit reads (D2.4-2). */
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Repository (transaction-scoped per the D2.4-1 pattern)
// ---------------------------------------------------------------------------

export type PublicationCreateRow = {
  readonly orgId: string;
  readonly subjectKind: PublicationSubjectKind;
  readonly subjectRef: string;
  readonly platformTarget: PlatformTarget;
  readonly contentType: PublicationContentType;
  readonly status: PublicationStatus;
  /** Approval-time QC review reference — set at approve; null until then. */
  readonly qcReviewId?: string | null;
};

export type PublicationVersionInsertRow = {
  readonly orgId: string;
  readonly publicationId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly synopsis: string | null;
  readonly contentType: PublicationContentType;
  readonly subjectKind: PublicationSubjectKind;
  readonly subjectRef: string;
  readonly createdBy: string | null;
};

export type PublicationUpdatePatch = {
  readonly status?: PublicationStatus;
  readonly currentVersionId?: string | null;
  /** Approval-time QC review stamp (set by approve; never client-supplied). */
  readonly qcReviewId?: string | null;
  readonly scheduledFor?: string | null;
  readonly attemptCount?: number;
  readonly lastFailureReason?: string | null;
  readonly lastAttemptAt?: string | null;
};

export type DistributionReferenceInsertRow = {
  readonly orgId: string;
  readonly publicationId: string;
  readonly versionId: string;
  readonly platformTarget: PlatformTarget;
  readonly externalRef: string | null;
  readonly deliveryOutcome: "delivered" | "failed";
  readonly failureReason: string | null;
};

/** Transaction surface handed to the service's `work` callback. */
export interface PublishingTransaction {
  findPublicationById(orgId: string, publicationId: string): Promise<PublicationRecordView | null>;
  insertPublication(input: PublicationCreateRow): Promise<PublicationRecordView>;
  updatePublication(publicationId: string, patch: PublicationUpdatePatch): Promise<PublicationRecordView>;
  insertVersion(input: PublicationVersionInsertRow): Promise<PublicationVersionRecord>;
  insertDistributionReference(input: DistributionReferenceInsertRow): Promise<DistributionReferenceRecord>;
  appendAudit(entry: Parameters<PublishingAuditAppend>[0]): Promise<void>;
}

export interface PublishingRepository {
  findPublicationById(orgId: string, publicationId: string): Promise<PublicationRecordView | null>;
  findPublicationBySubject(
    orgId: string,
    subjectKind: PublicationSubjectKind,
    subjectRef: string,
    platformTarget: PlatformTarget,
  ): Promise<PublicationRecordView | null>;
  listVersions(orgId: string, publicationId: string): Promise<readonly PublicationVersionRecord[]>;
  findVersionById(orgId: string, versionId: string): Promise<PublicationVersionRecord | null>;
  listDistributionReferences(orgId: string, publicationId: string): Promise<readonly DistributionReferenceRecord[]>;
  /**
   * Runs `work` on ONE transaction connection (mutation + audit commit
   * atomically). Repositories without transaction support fail closed.
   */
  runInTransaction<T>(work: (tx: PublishingTransaction) => Promise<T>): Promise<T>;
  /** D2.4-1 fallback audit seam (only when the repository has no tx support). */
  appendAudit?(entry: Parameters<PublishingAuditAppend>[0]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CreatePublicationInput {
  readonly subjectKind: PublicationSubjectKind;
  readonly subjectRef: string;
  readonly platformTarget: PlatformTarget;
  readonly contentType: PublicationContentType;
  /** Immutable v1 snapshot payload (D2.12-E). */
  readonly title: string;
  readonly synopsis?: string;
}

export interface SchedulePublicationInput {
  /** ISO-8601 timestamp; must be in the future. */
  readonly scheduledFor: string;
}

export interface RevisePublicationInput {
  readonly title?: string;
  readonly synopsis?: string;
  readonly qcReviewId?: string;
}

export type CreatePublicationOutcome = {
  readonly publication: PublicationRecordView;
  /** Version 1 — every successful create provisions the immutable v1. */
  readonly version: PublicationVersionRecord;
};

export type PublishOutcome = {
  readonly publication: PublicationRecordView;
  readonly reference: DistributionReferenceRecord;
};

export type PublicationDetail = {
  readonly publication: PublicationRecordView;
  readonly versions: readonly PublicationVersionRecord[];
  readonly distributionReferences: readonly DistributionReferenceRecord[];
};

export interface PublishingService {
  /** Creates publication + version v1; duplicates → publication_conflict. */
  createPublication(
    actor: PublicationActor,
    input: CreatePublicationInput,
  ): Promise<PublishingCommandResult<CreatePublicationOutcome>>;
  submit(actor: PublicationActor, publicationId: string): Promise<PublishingCommandResult<PublicationRecordView>>;
  approve(actor: PublicationActor, publicationId: string): Promise<PublishingCommandResult<PublicationRecordView>>;
  schedule(
    actor: PublicationActor,
    publicationId: string,
    input: SchedulePublicationInput,
  ): Promise<PublishingCommandResult<PublicationRecordView>>;
  /** Valid ONLY from `scheduled` (approved correction to the lifecycle). */
  publish(actor: PublicationActor, publicationId: string): Promise<PublishingCommandResult<PublishOutcome>>;
  retry(actor: PublicationActor, publicationId: string): Promise<PublishingCommandResult<PublicationRecordView>>;
  unpublish(actor: PublicationActor, publicationId: string): Promise<PublishingCommandResult<PublicationRecordView>>;
  /** D2.12-E: draft-only correction that appends version N+1. */
  revise(
    actor: PublicationActor,
    publicationId: string,
    input: RevisePublicationInput,
  ): Promise<PublishingCommandResult<PublicationVersionRecord>>;
  getPublication(actor: PublicationActor, publicationId: string): Promise<PublishingCommandResult<PublicationDetail>>;
}

/**
 * The FROZEN delivery attempt ceiling (Stage 2.12 contract):
 * MAX_PUBLISH_ATTEMPTS = 5. Attempts 1–5 are allowed; after the FIFTH failed
 * attempt `failed` becomes terminal — further publish attempts are rejected
 * with invalid_transition (failed is not a publish source) and retry is
 * rejected with max_attempts_exhausted.
 */
export const MAX_PUBLISH_ATTEMPTS = 5;
