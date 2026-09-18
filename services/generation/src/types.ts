/**
 * Generation-domain service ports (Stage 2.9, approved plan; D2.9-1..D2.9-4).
 *
 * services/generation owns the Generation bounded context (SVC section 11
 * context 7): generations + generation_provenance. No database imports here
 * — this module declares the injectable ports; the Drizzle adapter
 * implements them. Cross-module subjects (production, scene, shot, job,
 * output asset) stay LOOSE references (approved D2). D2.9-4: there is NO
 * Generation -> Jobs wiring — `jobId` is a loose column the production path
 * may set through its own approved increment later.
 *
 * Catalog resolution (D2.8-3 addressed at the Generation boundary): the
 * service resolves requested model/workflow selections against the durable
 * Catalog through the narrow registry ports below and pins the resolved
 * version UUIDs on the generation row. Resolution is FAIL-CLOSED: an
 * unresolvable or disabled version rejects the request. Pinned identities
 * are UUIDs, never free-form strings (invariants 8/9).
 */
import type { ControlCapability } from "@stratifit/permissions";

/** Operator authorization role (mirrors @stratifit/auth OperatorRole). */
export type OperatorRole = "admin" | "operator" | "reviewer" | "viewer";

/** DM section 32.3: the complete generation lifecycle — ALL states terminal. */
export type GenerationStatus = "requested" | "running" | "completed" | "failed" | "cancelled";

/**
 * The approved generation state machine (DM section 32.3). Legal edges ONLY.
 * `requested -> running` is the execution start (no real worker exists in
 * Stage 2.9 — this is a lifecycle transition only). `running` may reach
 * completed, failed, or cancelled. Terminal states have NO outgoing edges:
 * a retry is a NEW generation whose parent lineage preserves history
 * (DM section 32.3 "a retry is a new generation").
 */
export const GENERATION_TRANSITIONS: Readonly<Record<GenerationStatus, readonly GenerationStatus[]>> = {
  requested: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** States from which a generation may not transition (DM section 32.3). */
export const TERMINAL_GENERATION_STATUSES: readonly GenerationStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

/** Server-derived authorization facts a generation command actor must present. */
export interface GenerationActor {
  /** The acting operator's row id (identity.userId at composition roots). */
  readonly operatorId: string;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
  /** Optional correlation id propagated into audit records. */
  readonly correlationId?: string | null;
}

/**
 * A model version resolvable by the Catalog (Stage 2.8) — the only facts
 * generation needs to pin a reference and gate on registry status. The port
 * is structural: composition roots satisfy it with the Stage 2.8
 * createCatalogRepository (SVC sanctioned import: generation ──► ai).
 */
export interface ResolvedModelVersion {
  readonly id: string;
  readonly orgId: string;
  readonly modelId: string;
  readonly version: string;
  readonly status: "active" | "deprecated" | "disabled";
}

/** Workflow-version mirror of ResolvedModelVersion. */
export interface ResolvedWorkflowVersion {
  readonly id: string;
  readonly orgId: string;
  readonly workflowId: string;
  readonly version: string;
  readonly status: "active" | "deprecated" | "disabled";
}

/**
 * D2.8-3 resolution ports. `resolveModelVersion` takes (orgId, modelId,
 * version) EXACTLY as a manifest selection carries them and returns the
 * durable Catalog version row — or null when the selection cannot resolve
 * under the requesting organization. `findModel` / `findWorkflow` resolve
 * the parent for the generation's denormalized display ids.
 */
export interface ModelRegistryPort {
  findModel(orgId: string, modelId: string): Promise<{ id: string; orgId: string; name: string; status: string } | null>;
  resolveModelVersion(orgId: string, modelId: string, version: string): Promise<ResolvedModelVersion | null>;
}

export interface WorkflowRegistryPort {
  findWorkflow(orgId: string, workflowId: string): Promise<{ id: string; orgId: string; name: string; status: string } | null>;
  resolveWorkflowVersion(orgId: string, workflowId: string, version: string): Promise<ResolvedWorkflowVersion | null>;
}

export interface GenerationRecord {
  readonly id: string;
  readonly orgId: string;
  readonly status: GenerationStatus;
  /** Loose cross-module refs (approved D2) — never enforced by FK. */
  readonly productionId: string | null;
  readonly sceneId: string | null;
  readonly shotId: string | null;
  /** D2.9-4: loose job reference — no wiring exists. */
  readonly jobId: string | null;
  readonly outputAssetVersionId: string | null;
  /** Pinned Catalog resolution (invariants 8/9). */
  readonly modelId: string;
  readonly modelVersionId: string;
  readonly workflowId: string | null;
  readonly workflowVersionId: string | null;
  /** Lineage DAG via parent references; parents are never mutated. */
  readonly parentGenerationId: string | null;
  /** Request provenance — written at INSERT, never command-mutable. */
  readonly inputAssetVersionIds: readonly string[];
  readonly prompt: string;
  readonly negativePrompt: string | null;
  readonly seed: string | null;
  readonly parameters: Record<string, unknown>;
  readonly resolution: string | null;
  readonly fps: number | null;
  readonly durationSeconds: string | null;
  readonly adapters: readonly Record<string, unknown>[];
  readonly estimatedCostUsd: string | null;
  readonly requestKey: string | null;
  readonly lastError: string | null;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Immutable completion provenance (D2.9-1). One row per generation, written
 * ONCE by completeGeneration in the same transaction as the status
 * transition. workerRef / gpuClass are platform-agnostic identifiers — NEVER
 * credentials (invariant 4).
 */
export interface GenerationProvenanceRecord {
  readonly generationId: string;
  readonly orgId: string;
  readonly outputStorageKey: string | null;
  readonly outputChecksum: string | null;
  readonly outputByteSize: number | null;
  readonly executedSeed: string | null;
  readonly workerRef: string | null;
  readonly gpuClass: string | null;
  readonly runtimeVersion: string | null;
  readonly actualCostUsd: string | null;
  readonly actualRuntimeSeconds: number | null;
  readonly completedAt: string;
}

export type GenerationCommandErrorReason =
  | "missing_capability"
  | "cross_org"
  | "generation_not_found"
  | "parent_not_found"
  | "parent_cross_org"
  | "model_not_found"
  | "workflow_not_found"
  | "model_disabled"
  | "workflow_disabled"
  | "invalid_request"
  | "invalid_transition"
  | "completion_conflict";

export type GenerationCommandError = {
  readonly reason: GenerationCommandErrorReason;
  readonly message: string;
};

export type GenerationCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GenerationCommandError };

/**
 * Audit entry accepted by the sanctioned admin-audit seam (D2.4-1 reused;
 * same shape as the identity/jobs/catalog seams; composition roots map it
 * to admin-audit's canonical entry).
 */
export type GenerationAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "generation" | "generation_provenance";
  targetId: string;
  /** Org scope for organization-scoped audit reads (D2.4-2). */
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}) => Promise<void>;

export interface RequestGenerationInput {
  /** Manifest-selection facts (D2.8-3): resolved fail-closed at request. */
  readonly modelId: string;
  readonly modelVersion: string;
  readonly workflowId?: string | null;
  readonly workflowVersion?: string | null;
  /** Lineage: the parent generation (same org; parents never mutated). */
  readonly parentGenerationId?: string | null;
  /** Loose cross-module refs (approved D2). */
  readonly productionId?: string | null;
  readonly sceneId?: string | null;
  readonly shotId?: string | null;
  readonly inputAssetVersionIds?: readonly string[];
  /** Request provenance — written once at INSERT. */
  readonly prompt: string;
  readonly negativePrompt?: string | null;
  readonly seed?: string | null;
  readonly parameters?: Record<string, unknown>;
  readonly resolution?: string | null;
  readonly fps?: number | null;
  readonly durationSeconds?: string | null;
  readonly adapters?: readonly Record<string, unknown>[];
  readonly estimatedCostUsd?: string | null;
  /** API_ARCHITECTURE generation card: idempotency key (unique per org). */
  readonly requestKey?: string | null;
}

export interface CompleteGenerationInput {
  /** Output storage reference in the existing `generations` key namespace. */
  readonly outputStorageKey?: string | null;
  readonly outputChecksum?: string | null;
  readonly outputByteSize?: number | null;
  readonly executedSeed?: string | null;
  /** Platform-agnostic identifiers only — NEVER credentials (invariant 4). */
  readonly workerRef?: string | null;
  readonly gpuClass?: string | null;
  readonly runtimeVersion?: string | null;
  readonly actualCostUsd?: string | null;
  readonly actualRuntimeSeconds?: number | null;
  /** Loose assets reference (no assets family exists yet). */
  readonly outputAssetVersionId?: string | null;
}

/**
 * Transaction-scoped persistence + audit append (D2.4-1, reused not
 * duplicated): every actor-originated mutation and its audit record run on
 * the SAME database transaction. Implementations MUST NOT commit or roll
 * back inside `appendAudit` — transaction ownership stays with
 * `runInTransaction`.
 */
export interface GenerationTransaction {
  insertGeneration(input: {
    orgId: string;
    productionId: string | null;
    sceneId: string | null;
    shotId: string | null;
    jobId: string | null;
    parentGenerationId: string | null;
    modelId: string;
    modelVersionId: string;
    workflowId: string | null;
    workflowVersionId: string | null;
    inputAssetVersionIds: readonly string[];
    prompt: string;
    negativePrompt: string | null;
    seed: string | null;
    parameters: Record<string, unknown>;
    resolution: string | null;
    fps: number | null;
    durationSeconds: string | null;
    adapters: readonly Record<string, unknown>[];
    estimatedCostUsd: string | null;
    requestKey: string | null;
  }): Promise<GenerationRecord>;
  /** Status/startAt/lastError/outputAssetVersionId are the ONLY mutable columns. */
  updateGeneration(generationId: string, patch: {
    status?: GenerationStatus;
    startedAt?: string | null;
    lastError?: string | null;
    outputAssetVersionId?: string | null;
  }): Promise<GenerationRecord>;
  insertProvenance(input: {
    orgId: string;
    generationId: string;
    outputStorageKey: string | null;
    outputChecksum: string | null;
    outputByteSize: number | null;
    executedSeed: string | null;
    workerRef: string | null;
    gpuClass: string | null;
    runtimeVersion: string | null;
    actualCostUsd: string | null;
    actualRuntimeSeconds: number | null;
  }): Promise<GenerationProvenanceRecord>;
  appendAudit(entry: Parameters<GenerationAuditAppend>[0]): Promise<void>;
}

/** Durable generation-state port. */
export interface GenerationRepository {
  findGenerationById(id: string): Promise<GenerationRecord | null>;
  findGenerationByRequestKey(orgId: string, requestKey: string): Promise<GenerationRecord | null>;
  findProvenanceByGenerationId(generationId: string): Promise<GenerationProvenanceRecord | null>;
  listGenerationsByOrg(orgId: string, filter?: { status?: GenerationStatus; productionId?: string }): Promise<GenerationRecord[]>;

  insertGeneration(input: Parameters<GenerationTransaction["insertGeneration"]>[0]): Promise<GenerationRecord>;
  updateGeneration(generationId: string, patch: Parameters<GenerationTransaction["updateGeneration"]>[1]): Promise<GenerationRecord>;
  insertProvenance(input: Parameters<GenerationTransaction["insertProvenance"]>[0]): Promise<GenerationProvenanceRecord>;

  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction whose scoped
   * view is `GenerationTransaction`. The generation service uses this path
   * whenever it exists so an actor-originated mutation can never commit
   * without its audit record; the sequential fallback is test-only.
   */
  runInTransaction?<T>(work: (tx: GenerationTransaction) => Promise<T>): Promise<T>;
}
