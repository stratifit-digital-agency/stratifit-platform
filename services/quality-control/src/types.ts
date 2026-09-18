/**
 * QC-domain service ports (Stage 2.11, approved plan; D2.11-1..D2.11-8).
 *
 * services/quality-control owns the QC bounded context (SVC section 11
 * context 10): qc_checks, qc_reviews, qc_review_decisions, qc_results,
 * qc_issues. No database imports here — this module declares the injectable
 * ports; the Drizzle adapter implements them. Cross-module subjects
 * (asset_version, generation, production, publication) stay LOOSE references
 * (approved D2.11-2): there are NO cross-context foreign keys.
 *
 * HARD DOMAIN-SEPARATION RULE: QC decides QC review state ONLY. QC never
 * mutates asset approval state (assets.approval_state belongs to the Asset
 * aggregate); the EVENT_ARCHITECTURE wording "qc.requested → asset.approved"
 * is documentation debt and is NOT implemented — there is no Asset-mutation
 * dependency in this module at all.
 */
import type { ControlCapability } from "@stratifit/permissions";

/** Operator authorization role (mirrors @stratifit/auth OperatorRole). */
export type OperatorRole = "admin" | "operator" | "reviewer" | "viewer";

/** D2.11-2: the four DM section 18 subject kinds. */
export type QcSubjectKind = "asset_version" | "generation" | "production" | "publication";

/** DM section 18 check taxonomy. */
export type QcCheckType = "technical" | "moderation" | "rights" | "editorial";

/** D2.11-7: exactly active | archived. Archived checks take no new results. */
export type QcCheckStatus = "active" | "archived";

/** DM section 32.5: the complete QC Review lifecycle. */
export type QcReviewStatus = "pending" | "in_review" | "approved" | "rejected" | "changes_requested";

/** Terminal states have NO outgoing edges (DM section 32.5). */
export const TERMINAL_QC_REVIEW_STATUSES: readonly QcReviewStatus[] = ["approved", "rejected"];

/** D2.11-4: decisions only — qc.changes_requested is NOT a contract event. */
export type QcDecision = "approve" | "reject" | "changes_requested";

export type QcOutcome = "pass" | "fail" | "warn" | "skipped";

export type QcEvaluatedBy = "human" | "automated";

export type QcSeverity = "blocker" | "major" | "minor" | "note";

export type QcIssueResolution = "open" | "resolved" | "waived";

/**
 * The approved QC Review state machine (DM section 32.5). Legal edges ONLY.
 * `changes_requested → pending` is the correction loop; `approved` and
 * `rejected` are terminal at subject level (a superseding asset version is a
 * NEW subject_ref and gets a fresh review).
 */
export const QC_REVIEW_TRANSITIONS: Readonly<Record<QcReviewStatus, readonly QcReviewStatus[]>> = {
  pending: ["in_review"],
  in_review: ["approved", "rejected", "changes_requested"],
  approved: [],
  rejected: [],
  changes_requested: ["pending"],
};

/**
 * Server-derived authorization facts a QC command actor must present.
 * organizationId is ALWAYS the org authority; clients can never supply one.
 */
export interface QcActor {
  /** The acting operator's row id; null ONLY for execution/service actors. */
  readonly operatorId: string | null;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
  /** Optional correlation id propagated into audit records. */
  readonly correlationId?: string | null;
}

// ---------------------------------------------------------------------------
// Narrow read-only upstream subject-validation ports (D2.11-2). Structural:
// composition roots satisfy them with the Stage 2.8/2.9/2.10 repositories.
// They expose org-scoped lookups ONLY — QC never gains mutation access to
// any upstream family.
// ---------------------------------------------------------------------------

/** Asset-version mirror of the Stage 2.10 asset_versions row (org-scoped). */
export interface QcSubjectAssetVersion {
  readonly id: string;
  readonly orgId: string;
  readonly assetId: string;
  readonly versionNumber: number;
  readonly bucket: string;
  readonly storageKey: string;
  readonly checksum: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly technicalMetadata: Record<string, unknown>;
}

export interface QcAssetVersionPort {
  findAssetVersionById(orgId: string, assetVersionId: string): Promise<QcSubjectAssetVersion | null>;
}

/** Generation mirror of the Stage 2.9 generations row (org-scoped). */
export interface QcSubjectGeneration {
  readonly id: string;
  readonly orgId: string;
  readonly status: string;
}

export interface QcGenerationPort {
  findGenerationById(orgId: string, generationId: string): Promise<QcSubjectGeneration | null>;
}

/** Production mirror of the Stage 2.6 productions row (org-scoped). */
export interface QcSubjectProduction {
  readonly id: string;
  readonly orgId: string;
  readonly status: string;
}

export interface QcProductionPort {
  findProductionById(orgId: string, productionId: string): Promise<QcSubjectProduction | null>;
}

/** Resolved subject facts (subjectKind publication resolves to null → fail closed). */
export type ResolvedQcSubject =
  | { readonly kind: "asset_version"; readonly assetVersion: QcSubjectAssetVersion }
  | { readonly kind: "generation"; readonly generation: QcSubjectGeneration }
  | { readonly kind: "production"; readonly production: QcSubjectProduction }
  | { readonly kind: "publication"; readonly unsupported: true };

/**
 * D2.11-2 subject-resolution port: returns the resolved subject when it
 * exists inside the requesting organization; publication subjects return
 * the `unsupported` variant (FAIL CLOSED — durable Publishing does not
 * exist); a cross-org or absent subject returns null (IDOR-safe).
 */
export type QcResolvedSubjectPort = (
  orgId: string,
  subjectKind: QcSubjectKind,
  subjectRef: string,
) => Promise<ResolvedQcSubject | null>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface QcCheckRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly appliesToKind: QcSubjectKind;
  readonly checkType: QcCheckType;
  readonly parameters: Record<string, unknown>;
  readonly required: boolean;
  readonly status: QcCheckStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QcReviewRecord {
  readonly id: string;
  readonly orgId: string;
  readonly subjectKind: QcSubjectKind;
  readonly subjectRef: string;
  readonly status: QcReviewStatus;
  readonly requestedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Immutable decision record (D2.11-3). reviewer is never fabricated. */
export interface QcReviewDecisionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly reviewId: string;
  readonly decision: QcDecision;
  readonly reviewerOperatorId: string;
  readonly reason: string | null;
  readonly capabilityUsed: string;
  readonly createdAt: string;
}

/** Immutable result row (append-only history). */
export interface QcResultRecord {
  readonly id: string;
  readonly orgId: string;
  readonly reviewId: string;
  readonly checkId: string;
  readonly outcome: QcOutcome;
  readonly evaluatedBy: QcEvaluatedBy;
  readonly ruleRef: string | null;
  readonly details: Record<string, unknown>;
  readonly evaluatedAt: string;
}

export interface QcIssueRecord {
  readonly id: string;
  readonly orgId: string;
  readonly resultId: string;
  readonly severity: QcSeverity;
  readonly description: string;
  readonly resolution: QcIssueResolution;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type QcCommandErrorReason =
  | "missing_capability"
  | "cross_org"
  | "review_not_found"
  | "check_not_found"
  | "check_archived"
  | "subject_not_found"
  | "subject_unsupported"
  | "invalid_request"
  | "invalid_transition"
  | "decision_conflict"
  | "resolution_conflict";

export type QcCommandError = {
  readonly reason: QcCommandErrorReason;
  readonly message: string;
};

export type QcCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: QcCommandError };

/**
 * Audit entry accepted by the sanctioned admin-audit seam (D2.4-1 reused;
 * same shape as the identity/jobs/catalog/generation/asset seams;
 * composition roots map it to admin-audit's canonical entry).
 */
export type QcAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "qc_check" | "qc_review" | "qc_review_decision" | "qc_result" | "qc_issue";
  targetId: string;
  /** Org scope for organization-scoped audit reads (D2.4-2). */
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface RegisterQcCheckInput {
  readonly name: string;
  readonly appliesToKind: QcSubjectKind;
  readonly checkType: QcCheckType;
  readonly parameters?: Record<string, unknown>;
  readonly required?: boolean;
}

export interface UpdateQcCheckInput {
  readonly parameters?: Record<string, unknown>;
  readonly required?: boolean;
  readonly status?: QcCheckStatus;
}

export interface RequestReviewInput {
  readonly subjectKind: QcSubjectKind;
  readonly subjectRef: string;
}

export interface RecordDecisionInput {
  readonly decision: QcDecision;
  readonly reason?: string | null;
}

export interface RecordResultInput {
  readonly checkId: string;
  readonly outcome: QcOutcome;
  readonly evaluatedBy: QcEvaluatedBy;
  /** Required provenance for automated results (enforced by the service). */
  readonly ruleRef?: string | null;
  readonly details?: Record<string, unknown>;
}

export interface ResolveIssueInput {
  readonly resolution: "resolved" | "waived";
}

export interface QcRequestOutcome {
  readonly review: QcReviewRecord;
  /** True when the request resolved to the EXISTING review (idempotent dedupe). */
  readonly deduplicated: boolean;
}

/**
 * Transaction-scoped persistence + audit append (D2.4-1, reused not
 * duplicated): every actor-originated mutation and its audit record run on
 * the SAME database transaction. Implementations MUST NOT commit or roll
 * back inside `appendAudit` — transaction ownership stays with
 * `runInTransaction`.
 */
export interface QcTransaction {
  insertCheck(input: {
    orgId: string;
    name: string;
    appliesToKind: QcSubjectKind;
    checkType: QcCheckType;
    parameters: Record<string, unknown>;
    required: boolean;
  }): Promise<QcCheckRecord>;
  updateCheck(checkId: string, patch: {
    parameters?: Record<string, unknown>;
    required?: boolean;
    status?: QcCheckStatus;
  }): Promise<QcCheckRecord>;
  insertReview(input: {
    orgId: string;
    subjectKind: QcSubjectKind;
    subjectRef: string;
    requestedBy: string | null;
  }): Promise<QcReviewRecord>;
  updateReviewStatus(reviewId: string, status: QcReviewStatus): Promise<QcReviewRecord>;
  insertDecision(input: {
    orgId: string;
    reviewId: string;
    decision: QcDecision;
    reviewerOperatorId: string;
    reason: string | null;
    capabilityUsed: string;
  }): Promise<QcReviewDecisionRecord>;
  insertResult(input: {
    orgId: string;
    reviewId: string;
    checkId: string;
    outcome: QcOutcome;
    evaluatedBy: QcEvaluatedBy;
    ruleRef: string | null;
    details: Record<string, unknown>;
  }): Promise<QcResultRecord>;
  resolveIssue(issueId: string, input: {
    resolution: "resolved" | "waived";
    resolvedBy: string;
  }): Promise<QcIssueRecord>;
  appendAudit(entry: Parameters<QcAuditAppend>[0]): Promise<void>;
}

/** Durable QC-state port. No update/delete paths exist for immutable families. */
export interface QcRepository {
  findCheckById(orgId: string, checkId: string): Promise<QcCheckRecord | null>;
  findCheckByName(orgId: string, name: string): Promise<QcCheckRecord | null>;
  listChecksByOrg(orgId: string, filter?: { appliesToKind?: QcSubjectKind; status?: QcCheckStatus }): Promise<QcCheckRecord[]>;
  findReviewById(id: string): Promise<QcReviewRecord | null>;
  findReviewBySubject(orgId: string, subjectKind: QcSubjectKind, subjectRef: string): Promise<QcReviewRecord | null>;
  listReviewsByOrg(orgId: string, filter?: { status?: QcReviewStatus; subjectKind?: QcSubjectKind }): Promise<QcReviewRecord[]>;
  findDecisionById(id: string): Promise<QcReviewDecisionRecord | null>;
  listDecisionsByReviewId(reviewId: string): Promise<QcReviewDecisionRecord[]>;
  listResultsByReviewId(reviewId: string): Promise<QcResultRecord[]>;
  findIssueById(id: string): Promise<QcIssueRecord | null>;
  listIssuesByResultIds(resultIds: readonly string[]): Promise<QcIssueRecord[]>;

  insertCheck(input: Parameters<QcTransaction["insertCheck"]>[0]): Promise<QcCheckRecord>;
  updateCheck(checkId: string, patch: Parameters<QcTransaction["updateCheck"]>[1]): Promise<QcCheckRecord>;
  insertReview(input: Parameters<QcTransaction["insertReview"]>[0]): Promise<QcReviewRecord>;
  updateReviewStatus(reviewId: string, status: QcReviewStatus): Promise<QcReviewRecord>;
  insertDecision(input: Parameters<QcTransaction["insertDecision"]>[0]): Promise<QcReviewDecisionRecord>;
  insertResult(input: Parameters<QcTransaction["insertResult"]>[0]): Promise<QcResultRecord>;
  resolveIssue(issueId: string, input: Parameters<QcTransaction["resolveIssue"]>[1]): Promise<QcIssueRecord>;

  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction whose scoped
   * view is `QcTransaction`. The QC service uses this path whenever it exists
   * so an actor-originated mutation can never commit without its audit
   * record; the sequential fallback is test-only.
   */
  runInTransaction?<T>(work: (tx: QcTransaction) => Promise<T>): Promise<T>;
}
