/**
 * Production-domain service ports (Stage 2.6, decisions D2.6-1..D2.6-4).
 *
 * services/production-engine owns the Production bounded context (SVC
 * section 11 context 2): projects, productions, production_plan_versions,
 * gate_decision_records, manifest_versions. No vendor or database imports
 * here — this module declares the injectable ports; the Drizzle adapter
 * implements them. Cross-module references stay loose IDs (approved D2).
 */
import type {
  GateDecision,
  GateIssue,
} from "./gate";
import type { ProductionManifest } from "@stratifit/contracts";
import type { ControlCapability } from "@stratifit/permissions";
import type { OperatorRole } from "@stratifit/auth";

/** DOMAIN_MODEL section 7 ProductionKind. */
export type ProductionKind =
  | "film"
  | "series"
  | "episode"
  | "short"
  | "comedy"
  | "skit"
  | "music"
  | "documentary"
  | "live"
  | "trailer"
  | "advertisement";

/** DOMAIN_MODEL section 32 state machine 1 — explicit states, terminal: archived/cancelled. */
export type ProductionStatus =
  | "draft"
  | "planning"
  | "in_gate"
  | "approved"
  | "queued"
  | "in_production"
  | "post_production"
  | "qc"
  | "ready_for_publication"
  | "published"
  | "archived"
  | "on_hold"
  | "changes_requested"
  | "cancelled";

export type GateDecisionValue = "pass" | "fail";

export interface ProjectRecord {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: "active" | "archived";
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ProductionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly title: string;
  readonly kind: ProductionKind;
  /** Null until the first plan version is recorded. */
  readonly currentPlanVersionId: string | null;
  /** Null until the first manifest version is issued. */
  readonly currentManifestVersionId: string | null;
  readonly status: ProductionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly productionId: string;
  readonly versionNumber: number;
  /** Schema-validated ProductionPlanDocument (D2.6-2 inline jsonb). */
  readonly planDocument: Record<string, unknown>;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface GateDecisionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly productionId: string;
  readonly planVersionId: string;
  readonly decision: GateDecisionValue;
  /** Snapshot of the gate inputs (budget, moderation-planned). */
  readonly inputsSnapshot: Record<string, unknown>;
  readonly issues: readonly GateIssue[];
  readonly evaluatedBy: string;
  readonly evaluatedAt: string;
}

export interface ManifestVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly productionId: string;
  readonly planVersionId: string;
  readonly versionNumber: number;
  readonly manifestDocument: ProductionManifest;
  readonly issuedBy: string;
  readonly issuedAt: string;
}

/** Server-derived authorization facts a production command actor must present. */
export interface ProductionActor {
  /** The acting operator's row id (identity.userId at composition roots). */
  readonly operatorId: string;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
  /** Optional correlation id propagated into audit records. */
  readonly correlationId?: string | null;
}

export type ProductionCommandErrorReason =
  | "missing_capability"
  | "cross_org"
  | "project_not_found"
  | "production_not_found"
  | "plan_version_not_found"
  | "invalid_request"
  | "invalid_transition"
  | "gate_failed"
  | "gate_not_passed"
  | "manifest_not_issued"
  | "duplicate_slug";

export type ProductionCommandError = {
  readonly reason: ProductionCommandErrorReason;
  readonly message: string;
};

export type ProductionCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProductionCommandError };

/** The production state machine's approved transitions (DM section 32.1). */
export const PRODUCTION_TRANSITIONS: Readonly<
  Record<ProductionStatus, readonly ProductionStatus[]>
> = {
  draft: ["planning", "cancelled", "on_hold"],
  planning: ["in_gate", "draft", "cancelled", "on_hold"],
  in_gate: ["approved", "planning", "cancelled", "on_hold"],
  approved: ["queued", "cancelled", "on_hold"],
  queued: ["in_production", "cancelled", "on_hold"],
  in_production: ["post_production", "qc", "cancelled", "on_hold"],
  post_production: ["qc", "cancelled", "on_hold"],
  qc: ["ready_for_publication", "changes_requested", "cancelled", "on_hold"],
  ready_for_publication: ["published", "cancelled", "on_hold"],
  published: ["archived", "on_hold"],
  archived: [],
  on_hold: ["draft", "planning", "in_gate", "approved", "queued", "in_production", "post_production", "qc", "ready_for_publication", "published", "cancelled"],
  changes_requested: ["in_production", "cancelled", "on_hold"],
  cancelled: [],
};

/**
 * Audit entry accepted by the sanctioned admin-audit seam (same shape as the
 * identity D4 seam; composition roots map it to admin-audit's canonical entry).
 */
export type ProductionAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "project" | "production" | "plan_version" | "gate_decision" | "manifest_version";
  targetId: string;
  /** Org scope for organization-scoped audit reads (D2.4-2). */
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}) => Promise<void>;

/**
 * Transaction-scoped persistence + audit append (D2.4-1, reused not
 * duplicated): every security-critical mutation and its audit record run on
 * the SAME database transaction. Implementations MUST NOT commit or roll back
 * inside `appendAudit` — transaction ownership stays with `runInTransaction`.
 */
export interface ProductionTransaction {
  insertProject(input: { orgId: string; slug: string; name: string; description?: string | null; createdBy: string }): Promise<ProjectRecord>;
  insertProduction(input: { orgId: string; projectId: string; title: string; kind: ProductionKind }): Promise<ProductionRecord>;
  insertPlanVersion(input: { orgId: string; productionId: string; versionNumber: number; planDocument: Record<string, unknown>; createdBy: string }): Promise<PlanVersionRecord>;
  updateProduction(productionId: string, patch: { status?: ProductionStatus; currentPlanVersionId?: string | null; currentManifestVersionId?: string | null }): Promise<ProductionRecord>;
  insertGateDecision(input: { orgId: string; productionId: string; planVersionId: string; decision: GateDecisionValue; inputsSnapshot: Record<string, unknown>; issues: readonly GateIssue[]; evaluatedBy: string }): Promise<GateDecisionRecord>;
  insertManifestVersion(input: { orgId: string; productionId: string; planVersionId: string; versionNumber: number; manifestDocument: ProductionManifest; issuedBy: string }): Promise<ManifestVersionRecord>;
  appendAudit(entry: Parameters<ProductionAuditAppend>[0]): Promise<void>;
}

/** Durable production-state port. */
export interface ProductionRepository {
  findProjectBySlug(orgId: string, slug: string): Promise<ProjectRecord | null>;
  findProjectById(id: string): Promise<ProjectRecord | null>;
  listProjectsByOrg(orgId: string): Promise<ProjectRecord[]>;
  findProductionById(id: string): Promise<ProductionRecord | null>;
  listProductionsByOrg(orgId: string): Promise<ProductionRecord[]>;
  listProductionsByProject(projectId: string): Promise<ProductionRecord[]>;
  findPlanVersionById(id: string): Promise<PlanVersionRecord | null>;
  findLatestPlanVersion(productionId: string): Promise<PlanVersionRecord | null>;
  findPassingGateDecision(productionId: string, planVersionId: string): Promise<GateDecisionRecord | null>;
  findLatestManifestVersion(productionId: string): Promise<ManifestVersionRecord | null>;
  /**
   * Direct (non-transactional) mutations. The production service prefers
   * `runInTransaction` whenever it exists; these exist for the TEST-ONLY
   * sequential fallback (D2.4-1) and mirror the MembershipRepository design.
   */
  insertProject(input: { orgId: string; slug: string; name: string; description?: string | null; createdBy: string }): Promise<ProjectRecord>;
  insertProduction(input: { orgId: string; projectId: string; title: string; kind: ProductionKind }): Promise<ProductionRecord>;
  insertPlanVersion(input: { orgId: string; productionId: string; versionNumber: number; planDocument: Record<string, unknown>; createdBy: string }): Promise<PlanVersionRecord>;
  updateProduction(productionId: string, patch: { status?: ProductionStatus; currentPlanVersionId?: string | null; currentManifestVersionId?: string | null }): Promise<ProductionRecord>;
  insertGateDecision(input: { orgId: string; productionId: string; planVersionId: string; decision: GateDecisionValue; inputsSnapshot: Record<string, unknown>; issues: readonly { code: string; message: string }[]; evaluatedBy: string }): Promise<GateDecisionRecord>;
  insertManifestVersion(input: { orgId: string; productionId: string; planVersionId: string; versionNumber: number; manifestDocument: ProductionManifest; issuedBy: string }): Promise<ManifestVersionRecord>;
  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction whose scoped
   * view is `ProductionTransaction`. The production service uses this path
   * whenever it exists so a security-critical mutation can never commit
   * without its audit record; the sequential fallback is test-only.
   */
  runInTransaction?<T>(work: (tx: ProductionTransaction) => Promise<T>): Promise<T>;
}

/** Gate evaluation port over the existing pure `evaluateProductionGate`. */
export type ProductionGate = (input: {
  manifest: ProductionManifest;
  budgetUsd?: number | undefined;
  moderationPlanned?: boolean | undefined;
}) => GateDecision;

/** Convenience: a passing gate decision snapshot for tests/fixtures. */
export const gateDecisionPassed = (): GateDecision => ({ passed: true, issues: [] });
