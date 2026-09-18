/**
 * Durable model-registry service (Stage 2.8 Catalog Foundation).
 *
 * Commands enforce, in order: capability (`model.manage`) -> org boundary ->
 * invariant checks -> persistence -> same-transaction audit (D2.4-1, reused).
 * No events: no catalog event family exists in the approved event catalog;
 * the audit log is the record of administrative registry changes.
 *
 * DM section 14 semantics enforced here:
 *   - capability kind must be an approved CAPABILITY_KIND;
 *   - org name is unique (duplicate -> defined conflict, not silent dup);
 *   - versions are immutable rows: duplicate (org, model, version) -> conflict;
 *   - registry status transitions follow DM section 14 (`active` /
 *     `deprecated` / `disabled`); deprecated/disabled models still ACCEPT new
 *     version registrations (historical deprecation is not registry lockdown)
 *     but their versions register as `deprecated` so the planner treats them
 *     consistently.
 *
 * No deletes: DM section 14/15 — historical registry rows are never deleted.
 */
import type { ControlCapability } from "@stratifit/permissions";
import type { CatalogActor, CatalogCommandErrorReason, CatalogCommandResult, CatalogRepository, CatalogTransaction, ModelRecord, ModelRegistryStatus, ModelVersionRecord, WorkflowRecord, WorkflowVersionRecord } from "./types";

export interface CatalogServiceDeps {
  repository: CatalogRepository;
  /** Fallback audit seam (used only when the repository has no transaction support). */
  auditAppend?: Parameters<CatalogTransaction["appendAudit"]>[0] extends infer _E
    ? (entry: {
        actorId: string;
        action: string;
        targetType: string;
        targetId: string;
        organizationId?: string | null;
        correlationId?: string | null;
        causationId?: string | null;
        metadata?: Record<string, unknown>;
      }) => Promise<void>
    : never;
  /**
   * TEST-ONLY: permit the sequential (non-transactional) audit fallback for
   * repositories without `runInTransaction`. Production composition roots
   * never set it — there the service fail-closes instead (D2.4-1).
   */
  allowSequentialAudit?: boolean;
}

/** Registry status transition guard (DM section 14). */
const STATUS_TRANSITIONS: Record<ModelRegistryStatus, readonly ModelRegistryStatus[]> = {
  active: ["deprecated", "disabled"],
  deprecated: ["active", "disabled"],
  disabled: ["active"],
};

export interface CatalogService {
  registerModel(actor: CatalogActor, input: {
    name: string;
    capabilityKind: string;
    displayName: string;
    vendorLabel: string;
  }): Promise<CatalogCommandResult<ModelRecord>>;
  registerModelVersion(actor: CatalogActor, input: {
    modelId: string;
    version: string;
    adapterRef: string;
    compatibility?: Record<string, unknown>;
    defaultParameters?: Record<string, unknown>;
  }): Promise<CatalogCommandResult<ModelVersionRecord>>;
  updateModelStatus(actor: CatalogActor, input: { modelId: string; status: ModelRegistryStatus }): Promise<CatalogCommandResult<ModelRecord>>;
  listModels(actor: CatalogActor, filter?: { status?: ModelRegistryStatus; capabilityKind?: string }): Promise<ModelRecord[]>;
  getModel(actor: CatalogActor, modelId: string): Promise<CatalogCommandResult<{ model: ModelRecord; versions: ModelVersionRecord[] }>>;

  registerWorkflow(actor: CatalogActor, input: { name: string; supports: readonly string[] }): Promise<CatalogCommandResult<WorkflowRecord>>;
  registerWorkflowVersion(actor: CatalogActor, input: {
    workflowId: string;
    version: string;
    runtimeRef: string;
    definition?: Record<string, unknown>;
    compatibility?: Record<string, unknown>;
  }): Promise<CatalogCommandResult<WorkflowVersionRecord>>;
  updateWorkflowStatus(actor: CatalogActor, input: { workflowId: string; status: ModelRegistryStatus }): Promise<CatalogCommandResult<WorkflowRecord>>;
  listWorkflows(actor: CatalogActor, filter?: { status?: ModelRegistryStatus }): Promise<WorkflowRecord[]>;
  getWorkflow(actor: CatalogActor, workflowId: string): Promise<CatalogCommandResult<{ workflow: WorkflowRecord; versions: WorkflowVersionRecord[] }>>;
}

const MODEL_CAPABILITY: ControlCapability = "model.manage";
const WORKFLOW_CAPABILITY: ControlCapability = "workflow.manage";

const err = (reason: CatalogCommandErrorReason, message: string) => ({
  ok: false as const,
  error: { reason, message },
});

const isUUID = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Version strings are non-empty, bounded, and printable (registry hygiene). */
const validVersion = (v: string): boolean => v.length > 0 && v.length <= 128 && /^[\x20-\x7E]+$/.test(v);

export const createCatalogService = (deps: CatalogServiceDeps): CatalogService => {
  const repo = deps.repository;
  const fallbackAudit =
    deps.auditAppend ??
    (async () => {
      /* test-only fallback */
    });

  const requireCapability = (actor: CatalogActor, capability: ControlCapability) =>
    actor.capabilities.includes(capability)
      ? null
      : err("missing_capability", `${capability} capability required`);

  const auditEntry = (
    actor: CatalogActor,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: Record<string, unknown>,
  ): Parameters<CatalogTransaction["appendAudit"]>[0] => ({
    actorId: actor.operatorId,
    action,
    targetType,
    targetId,
    // D2.4-2: the acting operator's org scopes the audit record.
    organizationId: actor.organizationId,
    ...(metadata === undefined ? {} : { metadata }),
    correlationId: actor.correlationId ?? null,
    causationId: null,
  });

  /**
   * D2.4-1 dispatch (reused from the membership/production/jobs services):
   * run the mutation and its audit append inside ONE database transaction
   * when the repository supports it; otherwise fail closed unless the
   * test-only fallback flag is set.
   */
  const persistAndAudit = async <T>(
    actor: CatalogActor,
    action: string,
    targetType: string,
    describe: (value: T) => { targetId: string; metadata?: Record<string, unknown> },
    run: (tx: CatalogTransaction) => Promise<T>,
  ): Promise<T> => {
    if (repo.runInTransaction) {
      return await repo.runInTransaction<T>(async (tx): Promise<T> => {
        const value: T = await run(tx);
        const { targetId, metadata } = describe(value);
        await tx.appendAudit(auditEntry(actor, action, targetType, targetId, metadata));
        return value;
      });
    }
    if (deps.allowSequentialAudit !== true) {
      throw new Error(
        "D2.4-1 violation: repository does not implement runInTransaction; " +
          "catalog mutations cannot commit without a same-transaction audit " +
          "record. (The sequential audit fallback is test-only and must be " +
          "enabled explicitly via allowSequentialAudit.)",
      );
    }
    const value = await run(directTx());
    const { targetId, metadata } = describe(value);
    await fallbackAudit(auditEntry(actor, action, targetType, targetId, metadata));
    return value;
  };

  const directTx = (): CatalogTransaction => ({
    insertModel: (input) => repo.insertModel(input),
    updateModelStatus: (modelId, status) => repo.updateModelStatus(modelId, status),
    insertModelVersion: (input) => repo.insertModelVersion(input),
    insertWorkflow: (input) => repo.insertWorkflow(input),
    updateWorkflowStatus: (workflowId, status) => repo.updateWorkflowStatus(workflowId, status),
    insertWorkflowVersion: (input) => repo.insertWorkflowVersion(input),
    appendAudit: (entry) => fallbackAudit(entry),
  });

  return {
    registerModel: async (actor, input) => {
      const capErr = requireCapability(actor, MODEL_CAPABILITY);
      if (capErr) return capErr;
      const name = input.name.trim();
      if (!name || name.length > 200) return err("invalid_request", "model name must be 1-200 characters");
      if (!isUUID(actor.organizationId)) return err("invalid_request", "organizationId must be a UUID");
      // Capability-kind validation happens against the allowlist at insert
      // time via the schema CHECK; an early explicit check gives a clean
      // classified error instead of a raw constraint failure.
      const kind = input.capabilityKind;
      if (
        ![
          "image.generation",
          "video.generation",
          "voice.synthesis",
          "music.generation",
          "audio",
          "lip.sync",
          "sfx",
          "vfx",
          "enhancement",
        ].includes(kind)
      ) {
        return err("invalid_request", `unknown capability kind: ${kind}`);
      }
      const existing = await repo.findModelByName(actor.organizationId, name);
      if (existing) return err("duplicate_name", `model "${name}" already exists in this organization`);
      const model = await persistAndAudit<ModelRecord>(
        actor,
        "catalog.model.register",
        "model",
        (m) => ({ targetId: m.id, metadata: { name: m.name, capabilityKind: m.capabilityKind } }),
        (tx) =>
          tx.insertModel({
            orgId: actor.organizationId,
            name,
            capabilityKind: kind,
            displayName: input.displayName.trim() || name,
            vendorLabel: input.vendorLabel.trim() || "unknown",
            status: "active",
          }),
      );
      return { ok: true, value: model };
    },

    registerModelVersion: async (actor, input) => {
      const capErr = requireCapability(actor, MODEL_CAPABILITY);
      if (capErr) return capErr;
      if (!isUUID(input.modelId)) return err("invalid_request", "modelId must be a UUID");
      if (!validVersion(input.version)) return err("invalid_request", "version must be 1-128 printable characters");
      if (!input.adapterRef.trim()) return err("invalid_request", "adapterRef is required");
      const model = await repo.findModelById(input.modelId);
      if (!model || model.orgId !== actor.organizationId) {
        // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
        return err("model_not_found", "model not found");
      }
      const duplicate = await repo.findModelVersion(actor.organizationId, input.modelId, input.version);
      if (duplicate) {
        return err("duplicate_version", `version "${input.version}" already registered for this model`);
      }
      // DM section 14: deprecated/disabled parents still accept versions, but
      // the new row registers as `deprecated` so the planner never selects it
      // for new plans while historical references stay valid.
      const inherited: ModelRegistryStatus = model.status === "active" ? "active" : "deprecated";
      const version = await persistAndAudit<ModelVersionRecord>(
        actor,
        "catalog.model_version.register",
        "model_version",
        (v) => ({ targetId: v.id, metadata: { modelId: v.modelId, version: v.version, adapterRef: v.adapterRef } }),
        (tx) =>
          tx.insertModelVersion({
            orgId: actor.organizationId,
            modelId: input.modelId,
            version: input.version,
            adapterRef: input.adapterRef.trim(),
            compatibility: input.compatibility ?? {},
            defaultParameters: input.defaultParameters ?? {},
            status: inherited,
          }),
      );
      return { ok: true, value: version };
    },

    updateModelStatus: async (actor, input) => {
      const capErr = requireCapability(actor, MODEL_CAPABILITY);
      if (capErr) return capErr;
      if (!isUUID(input.modelId)) return err("invalid_request", "modelId must be a UUID");
      const model = await repo.findModelById(input.modelId);
      if (!model || model.orgId !== actor.organizationId) {
        return err("model_not_found", "model not found");
      }
      if (!STATUS_TRANSITIONS[model.status].includes(input.status)) {
        return err(
          "invalid_transition",
          `model status cannot move from ${model.status} to ${input.status}`,
        );
      }
      const updated = await persistAndAudit<ModelRecord>(
        actor,
        "catalog.model.status_update",
        "model",
        (m) => ({ targetId: m.id, metadata: { from: model.status, to: m.status } }),
        (tx) => tx.updateModelStatus(input.modelId, input.status),
      );
      return { ok: true, value: updated };
    },

    listModels: async (actor, filter) => {
      return repo.listModelsByOrg(actor.organizationId, filter);
    },

    getModel: async (actor, modelId) => {
      if (!isUUID(modelId)) return err("invalid_request", "modelId must be a UUID");
      const model = await repo.findModelById(modelId);
      if (!model || model.orgId !== actor.organizationId) {
        return err("model_not_found", "model not found");
      }
      return { ok: true, value: { model, versions: await repo.listModelVersions(modelId) } };
    },

    registerWorkflow: async (actor, input) => {
      const capErr = requireCapability(actor, WORKFLOW_CAPABILITY);
      if (capErr) return capErr;
      const name = input.name.trim();
      if (!name || name.length > 200) return err("invalid_request", "workflow name must be 1-200 characters");
      if (!isUUID(actor.organizationId)) return err("invalid_request", "organizationId must be a UUID");
      for (const kind of input.supports) {
        if (
          ![
            "image.generation",
            "video.generation",
            "voice.synthesis",
            "music.generation",
            "audio",
            "lip.sync",
            "sfx",
            "vfx",
            "enhancement",
          ].includes(kind)
        ) {
          return err("invalid_request", `unknown capability kind in supports: ${kind}`);
        }
      }
      const existing = await repo.findWorkflowByName(actor.organizationId, name);
      if (existing) return err("duplicate_name", `workflow "${name}" already exists in this organization`);
      const workflow = await persistAndAudit<WorkflowRecord>(
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
      const capErr = requireCapability(actor, WORKFLOW_CAPABILITY);
      if (capErr) return capErr;
      if (!isUUID(input.workflowId)) return err("invalid_request", "workflowId must be a UUID");
      if (!validVersion(input.version)) return err("invalid_request", "version must be 1-128 printable characters");
      if (!input.runtimeRef.trim()) return err("invalid_request", "runtimeRef is required");
      const workflow = await repo.findWorkflowById(input.workflowId);
      if (!workflow || workflow.orgId !== actor.organizationId) {
        return err("workflow_not_found", "workflow not found");
      }
      const duplicate = await repo.findWorkflowVersion(actor.organizationId, input.workflowId, input.version);
      if (duplicate) {
        return err("duplicate_version", `version "${input.version}" already registered for this workflow`);
      }
      const inherited: ModelRegistryStatus = workflow.status === "active" ? "active" : "deprecated";
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
      const capErr = requireCapability(actor, WORKFLOW_CAPABILITY);
      if (capErr) return capErr;
      if (!isUUID(input.workflowId)) return err("invalid_request", "workflowId must be a UUID");
      const workflow = await repo.findWorkflowById(input.workflowId);
      if (!workflow || workflow.orgId !== actor.organizationId) {
        return err("workflow_not_found", "workflow not found");
      }
      if (!STATUS_TRANSITIONS[workflow.status].includes(input.status)) {
        return err(
          "invalid_transition",
          `workflow status cannot move from ${workflow.status} to ${input.status}`,
        );
      }
      const updated = await persistAndAudit<WorkflowRecord>(
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
