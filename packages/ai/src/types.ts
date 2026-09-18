/**
 * Catalog service types (Stage 2.8, approved Catalog Foundation plan).
 *
 * Durable Model/Workflow registries (bounded context 8, aggregates 15/16 in
 * DOMAIN_MODEL section 29). Ownership per SERVICE_ARCHITECTURE section 11
 * context 8: packages/ai owns model registry logic and its persistence via
 * packages/database — vendor-free, adapter-identified (invariant 20).
 */
import type { Database } from "@stratifit/database";
import type { ControlCapability } from "@stratifit/permissions";

export type OperatorRole = "admin" | "operator" | "reviewer" | "viewer";

/** DM section 14 registry statuses. Transitions are guarded in the service. */
export type ModelRegistryStatus = "active" | "deprecated" | "disabled";

/** Server-derived actor (composition roots never trust client claims). */
export interface CatalogActor {
  readonly operatorId: string;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
  readonly correlationId?: string | null;
}

export interface ModelRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly capabilityKind: string;
  readonly displayName: string;
  /** Operator-UI display metadata — never a domain/provider concept. */
  readonly vendorLabel: string;
  readonly status: ModelRegistryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModelVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly modelId: string;
  readonly version: string;
  /** Platform-agnostic adapter identifier (packages/ai registry key). */
  readonly adapterRef: string;
  readonly compatibility: Record<string, unknown>;
  readonly defaultParameters: Record<string, unknown>;
  readonly status: ModelRegistryStatus;
  readonly registeredAt: string;
}

export interface WorkflowRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly supports: readonly string[];
  readonly status: ModelRegistryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly workflowId: string;
  readonly version: string;
  /** Platform-agnostic runtime-TYPE identifier (never a vendor concept). */
  readonly runtimeRef: string;
  /** Opaque runtime-interpreted definition payload (D2.8-2: jsonb column). */
  readonly definition: Record<string, unknown>;
  readonly compatibility: Record<string, unknown>;
  readonly status: ModelRegistryStatus;
  readonly registeredAt: string;
}

export type CatalogCommandErrorReason =
  | "missing_capability"
  | "invalid_request"
  | "duplicate_name"
  | "duplicate_version"
  | "model_not_found"
  | "workflow_not_found"
  | "invalid_transition"
  | "cross_org";

export type CatalogCommandError = { reason: CatalogCommandErrorReason; message: string };
export type CatalogCommandResult<T> = { ok: true; value: T } | { ok: false; error: CatalogCommandError };

/** D2.4-1 seam (reused): transaction-scoped audit append; never commits. */
export type CatalogAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  organizationId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

/** Transaction-scoped mutations + audit append (runs on ONE connection). */
export interface CatalogTransaction {
  insertModel(input: {
    orgId: string;
    name: string;
    capabilityKind: string;
    displayName: string;
    vendorLabel: string;
    status: ModelRegistryStatus;
  }): Promise<ModelRecord>;
  updateModelStatus(modelId: string, status: ModelRegistryStatus): Promise<ModelRecord>;
  insertModelVersion(input: {
    orgId: string;
    modelId: string;
    version: string;
    adapterRef: string;
    compatibility: Record<string, unknown>;
    defaultParameters: Record<string, unknown>;
    status: ModelRegistryStatus;
  }): Promise<ModelVersionRecord>;
  insertWorkflow(input: {
    orgId: string;
    name: string;
    supports: readonly string[];
    status: ModelRegistryStatus;
  }): Promise<WorkflowRecord>;
  updateWorkflowStatus(workflowId: string, status: ModelRegistryStatus): Promise<WorkflowRecord>;
  insertWorkflowVersion(input: {
    orgId: string;
    workflowId: string;
    version: string;
    runtimeRef: string;
    definition: Record<string, unknown>;
    compatibility: Record<string, unknown>;
    status: ModelRegistryStatus;
  }): Promise<WorkflowVersionRecord>;
  appendAudit(entry: Parameters<CatalogAuditAppend>[0]): Promise<void>;
}

/** Durable catalog port (org-scoped by the service). */
export interface CatalogRepository {
  findModelById(id: string): Promise<ModelRecord | null>;
  findModelByName(orgId: string, name: string): Promise<ModelRecord | null>;
  listModelsByOrg(orgId: string, filter?: { status?: ModelRegistryStatus; capabilityKind?: string }): Promise<ModelRecord[]>;
  findModelVersion(orgId: string, modelId: string, version: string): Promise<ModelVersionRecord | null>;
  listModelVersions(modelId: string): Promise<ModelVersionRecord[]>;
  findWorkflowById(id: string): Promise<WorkflowRecord | null>;
  findWorkflowByName(orgId: string, name: string): Promise<WorkflowRecord | null>;
  listWorkflowsByOrg(orgId: string, filter?: { status?: ModelRegistryStatus }): Promise<WorkflowRecord[]>;
  findWorkflowVersion(orgId: string, workflowId: string, version: string): Promise<WorkflowVersionRecord | null>;
  listWorkflowVersions(workflowId: string): Promise<WorkflowVersionRecord[]>;

  insertModel(input: Parameters<CatalogTransaction["insertModel"]>[0]): Promise<ModelRecord>;
  updateModelStatus(modelId: string, status: ModelRegistryStatus): Promise<ModelRecord>;
  insertModelVersion(input: Parameters<CatalogTransaction["insertModelVersion"]>[0]): Promise<ModelVersionRecord>;
  insertWorkflow(input: Parameters<CatalogTransaction["insertWorkflow"]>[0]): Promise<WorkflowRecord>;
  updateWorkflowStatus(workflowId: string, status: ModelRegistryStatus): Promise<WorkflowRecord>;
  insertWorkflowVersion(input: Parameters<CatalogTransaction["insertWorkflowVersion"]>[0]): Promise<WorkflowVersionRecord>;

  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction so a
   * registry mutation can never commit without its audit record. The
   * sequential audit fallback is TEST-ONLY (see createCatalogService).
   */
  runInTransaction?<T>(work: (tx: CatalogTransaction) => Promise<T>): Promise<T>;
}

/** Concrete Drizzle repository type (deps + port; no extra seams needed). */
export type DrizzleCatalogRepositoryDeps = {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /** D2.4-1 (required): the admin-audit transaction writer (structural type). */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<CatalogAuditAppend>[0]): Promise<void> };
};
