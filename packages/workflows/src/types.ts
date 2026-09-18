/**
 * Catalog service types — workflow side (Stage 2.8).
 *
 * The workflow registry mirrors packages/ai's catalog port exactly
 * (SERVICE_ARCHITECTURE section 11 context 8: durable rows owned by
 * packages/workflows via packages/database). The model-side types live in
 * @stratifit/ai; the workflow types are re-declared here so each package
 * owns its own context surface without cross-importing the other's internals.
 */
import type { Database } from "@stratifit/database";
import type { ControlCapability } from "@stratifit/permissions";

export type OperatorRole = "admin" | "operator" | "reviewer" | "viewer";

/** DM section 15 registry statuses (same vocabulary as the model registry). */
export type WorkflowRegistryStatus = "active" | "deprecated" | "disabled";

/** Server-derived actor (composition roots never trust client claims). */
export interface WorkflowCatalogActor {
  readonly operatorId: string;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
  readonly correlationId?: string | null;
}

export interface WorkflowCatalogRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly supports: readonly string[];
  readonly status: WorkflowRegistryStatus;
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
  readonly status: WorkflowRegistryStatus;
  readonly registeredAt: string;
}

export type WorkflowCatalogErrorReason =
  | "missing_capability"
  | "invalid_request"
  | "duplicate_name"
  | "duplicate_version"
  | "workflow_not_found"
  | "invalid_transition"
  | "cross_org";

export type WorkflowCatalogResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { reason: WorkflowCatalogErrorReason; message: string } };

/** D2.4-1 seam (reused): transaction-scoped audit append; never commits. */
export type WorkflowCatalogAuditAppend = (entry: {
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
export interface WorkflowCatalogTransaction {
  insertWorkflow(input: {
    orgId: string;
    name: string;
    supports: readonly string[];
    status: WorkflowRegistryStatus;
  }): Promise<WorkflowCatalogRecord>;
  updateWorkflowStatus(workflowId: string, status: WorkflowRegistryStatus): Promise<WorkflowCatalogRecord>;
  insertWorkflowVersion(input: {
    orgId: string;
    workflowId: string;
    version: string;
    runtimeRef: string;
    definition: Record<string, unknown>;
    compatibility: Record<string, unknown>;
    status: WorkflowRegistryStatus;
  }): Promise<WorkflowVersionRecord>;
  appendAudit(entry: Parameters<WorkflowCatalogAuditAppend>[0]): Promise<void>;
}

/** Durable workflow-catalog port (org-scoped by the service). */
export interface WorkflowCatalogRepository {
  findWorkflowById(id: string): Promise<WorkflowCatalogRecord | null>;
  findWorkflowByName(orgId: string, name: string): Promise<WorkflowCatalogRecord | null>;
  listWorkflowsByOrg(orgId: string, filter?: { status?: WorkflowRegistryStatus }): Promise<WorkflowCatalogRecord[]>;
  findWorkflowVersion(orgId: string, workflowId: string, version: string): Promise<WorkflowVersionRecord | null>;
  listWorkflowVersions(workflowId: string): Promise<WorkflowVersionRecord[]>;

  insertWorkflow(input: Parameters<WorkflowCatalogTransaction["insertWorkflow"]>[0]): Promise<WorkflowCatalogRecord>;
  updateWorkflowStatus(workflowId: string, status: WorkflowRegistryStatus): Promise<WorkflowCatalogRecord>;
  insertWorkflowVersion(input: Parameters<WorkflowCatalogTransaction["insertWorkflowVersion"]>[0]): Promise<WorkflowVersionRecord>;

  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction so a
   * registry mutation can never commit without its audit record.
   */
  runInTransaction?<T>(work: (tx: WorkflowCatalogTransaction) => Promise<T>): Promise<T>;
}

export type DrizzleWorkflowCatalogRepositoryDeps = {
  db?: Database;
  databaseUrl?: string;
  /** D2.4-1 (required): the admin-audit transaction writer (structural type). */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<WorkflowCatalogAuditAppend>[0]): Promise<void> };
};
