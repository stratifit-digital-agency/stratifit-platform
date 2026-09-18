/**
 * Durable workflow-registry service (Stage 2.8 Catalog Foundation).
 *
 * Commands enforce, in order: capability (`workflow.manage`) -> org boundary
 * -> invariant checks -> persistence -> same-transaction audit (D2.4-1,
 * reused). No events: no catalog event family exists in the approved event
 * catalog; the audit log is the record of administrative registry changes.
 *
 * DM section 15 semantics: capability kinds validated against the approved
 * allowlist; org name unique; versions immutable (duplicate (org, workflow,
 * version) -> conflict); no deletes — historical versions are never removed.
 */
import type { ControlCapability } from "@stratifit/permissions";
import type {
  WorkflowCatalogActor,
  WorkflowCatalogErrorReason,
  WorkflowCatalogRecord,
  WorkflowCatalogRepository,
  WorkflowCatalogResult,
  WorkflowCatalogTransaction,
  WorkflowRegistryStatus,
  WorkflowVersionRecord,
} from "./types";

export interface WorkflowCatalogServiceDeps {
  repository: WorkflowCatalogRepository;
  /** Fallback audit seam (used only when the repository has no transaction support). */
  auditAppend?: (entry: Parameters<WorkflowCatalogTransaction["appendAudit"]>[0]) => Promise<void>;
  /** TEST-ONLY: permit the sequential audit fallback (D2.4-1 fail-closed otherwise). */
  allowSequentialAudit?: boolean;
}

/** Registry status transition guard (mirrors the model registry). */
const STATUS_TRANSITIONS: Record<WorkflowRegistryStatus, readonly WorkflowRegistryStatus[]> = {
  active: ["deprecated", "disabled"],
  deprecated: ["active", "disabled"],
  disabled: ["active"],
};

/** DM section 15 / packages/contracts capability allowlist. */
const CAPABILITY_KINDS: readonly string[] = [
  "image.generation",
  "video.generation",
  "voice.synthesis",
  "music.generation",
  "audio",
  "lip.sync",
  "sfx",
  "vfx",
  "enhancement",
];

const WORKFLOW_CAPABILITY: ControlCapability = "workflow.manage";

const err = (reason: WorkflowCatalogErrorReason, message: string) => ({
  ok: false as const,
  error: { reason, message },
});

const isUUID = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const validVersion = (v: string): boolean => v.length > 0 && v.length <= 128 && /^[\x20-\x7E]+$/.test(v);

export interface WorkflowCatalogService {
  registerWorkflow(actor: WorkflowCatalogActor, input: { name: string; supports: readonly string[] }): Promise<WorkflowCatalogResult<WorkflowCatalogRecord>>;
  registerWorkflowVersion(actor: WorkflowCatalogActor, input: {
    workflowId: string;
    version: string;
    runtimeRef: string;
    definition?: Record<string, unknown>;
    compatibility?: Record<string, unknown>;
  }): Promise<WorkflowCatalogResult<WorkflowVersionRecord>>;
  updateWorkflowStatus(actor: WorkflowCatalogActor, input: { workflowId: string; status: WorkflowRegistryStatus }): Promise<WorkflowCatalogResult<WorkflowCatalogRecord>>;
  listWorkflows(actor: WorkflowCatalogActor, filter?: { status?: WorkflowRegistryStatus }): Promise<WorkflowCatalogRecord[]>;
  getWorkflow(actor: WorkflowCatalogActor, workflowId: string): Promise<WorkflowCatalogResult<{ workflow: WorkflowCatalogRecord; versions: WorkflowVersionRecord[] }>>;
}

export const createWorkflowCatalogService = (deps: WorkflowCatalogServiceDeps): WorkflowCatalogService => {
  const repo = deps.repository;
  const fallbackAudit =
    deps.auditAppend ??
    (async () => {
      /* test-only fallback */
    });

  const requireCapability = (actor: WorkflowCatalogActor) =>
    actor.capabilities.includes(WORKFLOW_CAPABILITY)
      ? null
      : err("missing_capability", `${WORKFLOW_CAPABILITY} capability required`);

  const auditEntry = (
    actor: WorkflowCatalogActor,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: Record<string, unknown>,
  ): Parameters<WorkflowCatalogTransaction["appendAudit"]>[0] => ({
    actorId: actor.operatorId,
    action,
    targetType,
    targetId,
    organizationId: actor.organizationId,
    ...(metadata === undefined ? {} : { metadata }),
    correlationId: actor.correlationId ?? null,
    causationId: null,
  });

  const persistAndAudit = async <T>(
    actor: WorkflowCatalogActor,
    action: string,
    targetType: string,
    describe: (value: T) => { targetId: string; metadata?: Record<string, unknown> },
    run: (tx: WorkflowCatalogTransaction) => Promise<T>,
  ): Promise<T> => {
    if (repo.runInTransaction) {
      return repo.runInTransaction(async (tx) => {
        const value = await run(tx);
        const { targetId, metadata } = describe(value);
        await tx.appendAudit(auditEntry(actor, action, targetType, targetId, metadata));
        return value;
      });
    }
    if (deps.allowSequentialAudit !== true) {
      throw new Error(
        "D2.4-1 violation: repository does not implement runInTransaction; " +
          "workflow catalog mutations cannot commit without a same-transaction " +
          "audit record. (The sequential audit fallback is test-only and must " +
          "be enabled explicitly via allowSequentialAudit.)",
      );
    }
    const value = await run(directTx());
    const { targetId, metadata } = describe(value);
    await fallbackAudit(auditEntry(actor, action, targetType, targetId, metadata));
    return value;
  };

  const directTx = (): WorkflowCatalogTransaction => ({
    insertWorkflow: (input) => repo.insertWorkflow(input),
    updateWorkflowStatus: (workflowId, status) => repo.updateWorkflowStatus(workflowId, status),
    insertWorkflowVersion: (input) => repo.insertWorkflowVersion(input),
    appendAudit: (entry) => fallbackAudit(entry),
  });

  return {
    registerWorkflow: async (actor, input) => {
      const capErr = requireCapability(actor);
      if (capErr) return capErr;
      const name = input.name.trim();
      if (!name || name.length > 200) return err("invalid_request", "workflow name must be 1-200 characters");
      if (!isUUID(actor.organizationId)) return err("invalid_request", "organizationId must be a UUID");
      for (const kind of input.supports) {
        if (!CAPABILITY_KINDS.includes(kind)) {
          return err("invalid_request", `unknown capability kind in supports: ${kind}`);
        }
      }
      const existing = await repo.findWorkflowByName(actor.organizationId, name);
      if (existing) return err("duplicate_name", `workflow "${name}" already exists in this organization`);
      const workflow = await persistAndAudit<WorkflowCatalogRecord>(
        actor,
        "catalog.workflow.register",
        "workflow",
        (w) => ({ targetId: w.id, metadata: { name: w.name, supports: [...w.supports] } }),
        (tx) =>
          tx.insertWorkflow({
            orgId: actor.organizationId,
            name,
            supports: input.supports,
            status: "active",
          }),
      );
      return { ok: true, value: workflow };
    },

    registerWorkflowVersion: async (actor, input) => {
      const capErr = requireCapability(actor);
      if (capErr) return capErr;
      if (!isUUID(input.workflowId)) return err("invalid_request", "workflowId must be a UUID");
      if (!validVersion(input.version)) return err("invalid_request", "version must be 1-128 printable characters");
      if (!input.runtimeRef.trim()) return err("invalid_request", "runtimeRef is required");
      const workflow = await repo.findWorkflowById(input.workflowId);
      if (!workflow || workflow.orgId !== actor.organizationId) {
        // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
        return err("workflow_not_found", "workflow not found");
      }
      const duplicate = await repo.findWorkflowVersion(actor.organizationId, input.workflowId, input.version);
      if (duplicate) {
        return err("duplicate_version", `version "${input.version}" already registered for this workflow`);
      }
      // DM section 15: deprecated/disabled parents still accept versions, but
      // the new row registers as `deprecated` (planner never selects it for
      // new plans while historical references stay valid).
      const inherited: WorkflowRegistryStatus = workflow.status === "active" ? "active" : "deprecated";
      const version = await persistAndAudit<WorkflowVersionRecord>(
        actor,
        "catalog.workflow_version.register",
        "workflow_version",
        (v) => ({ targetId: v.id, metadata: { workflowId: v.workflowId, version: v.version, runtimeRef: v.runtimeRef } }),
        (tx) =>
          tx.insertWorkflowVersion({
            orgId: actor.organizationId,
            workflowId: input.workflowId,
            version: input.version,
            runtimeRef: input.runtimeRef.trim(),
            definition: input.definition ?? {},
            compatibility: input.compatibility ?? {},
            status: inherited,
          }),
      );
      return { ok: true, value: version };
    },

    updateWorkflowStatus: async (actor, input) => {
      const capErr = requireCapability(actor);
      if (capErr) return capErr;
      if (!isUUID(input.workflowId)) return err("invalid_request", "workflowId must be a UUID");
      const workflow = await repo.findWorkflowById(input.workflowId);
      if (!workflow || workflow.orgId !== actor.organizationId) {
        return err("workflow_not_found", "workflow not found");
      }
      if (!STATUS_TRANSITIONS[workflow.status].includes(input.status)) {
        return err("invalid_transition", `workflow status cannot move from ${workflow.status} to ${input.status}`);
      }
      const updated = await persistAndAudit<WorkflowCatalogRecord>(
        actor,
        "catalog.workflow.status_update",
        "workflow",
        (w) => ({ targetId: w.id, metadata: { from: workflow.status, to: w.status } }),
        (tx) => tx.updateWorkflowStatus(input.workflowId, input.status),
      );
      return { ok: true, value: updated };
    },

    listWorkflows: async (actor, filter) => {
      return repo.listWorkflowsByOrg(actor.organizationId, filter);
    },

    getWorkflow: async (actor, workflowId) => {
      if (!isUUID(workflowId)) return err("invalid_request", "workflowId must be a UUID");
      const workflow = await repo.findWorkflowById(workflowId);
      if (!workflow || workflow.orgId !== actor.organizationId) {
        return err("workflow_not_found", "workflow not found");
      }
      return { ok: true, value: { workflow, versions: await repo.listWorkflowVersions(workflowId) } };
    },
  };
};
