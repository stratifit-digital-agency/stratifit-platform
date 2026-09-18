/**
 * Generation domain service (Stage 2.9, approved decisions D2.9-1..D2.9-4).
 *
 * Operator-originated commands enforce, in order: capability
 * (`generation.request`) -> org boundary -> deterministic validation ->
 * state-machine validity -> persistence -> post-commit event publication
 * (Stage-1 semantics, existing generation.* names only). Execution-path
 * transitions (start/complete/fail carried by the platform, not operators)
 * are NOT operator-audited in Stage 2.9 (the ratified Stage 2.7 audit
 * matrix); requestGeneration and cancelGeneration are actor-originated and
 * audited.
 *
 * D2.4-1 (reused): actor-originated mutations (requestGeneration,
 * cancelGeneration) and their audit records commit inside the SAME database
 * transaction via `GenerationRepository.runInTransaction` — a crash before
 * COMMIT rolls back BOTH, and a successful mutation cannot commit without
 * its audit record. Repositories without transaction support fail closed
 * unless the TEST-ONLY `allowSequentialAudit` flag is set; production
 * composition roots never set it.
 *
 * D2.9-4: there is NO Generation -> Jobs wiring — this service never
 * enqueues, claims, or executes anything. NO AI execution exists here:
 * startGeneration only performs the documented lifecycle transition; a
 * failed transaction never publishes an event; terminal states have no
 * outgoing edges (a retry is a NEW generation via parent lineage).
 */
import { randomUUID } from "node:crypto";
import type { ControlCapability } from "@stratifit/permissions";
import { emitEvent, InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  CompleteGenerationInput,
  GenerationActor,
  GenerationAuditAppend,
  GenerationCommandErrorReason,
  GenerationCommandResult,
  GenerationProvenanceRecord,
  GenerationRecord,
  GenerationRepository,
  GenerationStatus,
  GenerationTransaction,
  ModelRegistryPort,
  RequestGenerationInput,
  WorkflowRegistryPort,
} from "./types";
import { GENERATION_TRANSITIONS, TERMINAL_GENERATION_STATUSES } from "./types";

export interface GenerationServiceDeps {
  repository: GenerationRepository;
  /** D2.8-3: fail-closed Catalog resolution ports (structural; Stage 2.8 repos). */
  modelRegistry: ModelRegistryPort;
  workflowRegistry?: WorkflowRegistryPort;
  /** Defaults to an in-process publisher with no handlers (Stage-1 semantics). */
  publisher?: EventPublisher;
  /** Fallback audit seam (used only when the repository has no transaction support). */
  auditAppend?: GenerationAuditAppend;
  /**
   * TEST-ONLY: permit the sequential (non-transactional) audit fallback for
   * repositories without `runInTransaction`. Production composition roots
   * never set it — there the service fail-closes instead (D2.4-1).
   */
  allowSequentialAudit?: boolean;
  eventIdFactory?: () => string;
}

export interface RequestOutcome {
  readonly generation: GenerationRecord;
  /** True when the request resolved to the EXISTING generation (idempotent dedupe). */
  readonly deduplicated: boolean;
}

export interface GenerationService {
  // ---- operator-originated (capability-gated, audited) ----
  requestGeneration(
    actor: GenerationActor,
    input: RequestGenerationInput,
  ): Promise<GenerationCommandResult<RequestOutcome>>;
  cancelGeneration(actor: GenerationActor, generationId: string): Promise<GenerationCommandResult<GenerationRecord>>;

  // ---- execution-path lifecycle transitions (NOT operator-audited in 2.9;
  //      they perform state changes ONLY — no worker, no provider, no model) ----
  startGeneration(generationId: string): Promise<GenerationCommandResult<GenerationRecord>>;
  completeGeneration(
    generationId: string,
    input: CompleteGenerationInput,
  ): Promise<GenerationCommandResult<{ generation: GenerationRecord; provenance: GenerationProvenanceRecord }>>;
  failGeneration(generationId: string, input: { errorDetail: string }): Promise<GenerationCommandResult<GenerationRecord>>;

  // ---- org-scoped queries ----
  getGeneration(actor: GenerationActor, generationId: string): Promise<GenerationCommandResult<GenerationRecord>>;
  getProvenance(
    actor: GenerationActor,
    generationId: string,
  ): Promise<GenerationCommandResult<{ generation: GenerationRecord; provenance: GenerationProvenanceRecord }>>;
  listGenerations(
    actor: GenerationActor,
    filter?: { status?: GenerationStatus; productionId?: string },
  ): Promise<GenerationRecord[]>;
}

const GENERATION_CAPABILITY: ControlCapability = "generation.request";

export const createGenerationService = (deps: GenerationServiceDeps): GenerationService => {
  const repo = deps.repository;
  const publisher = deps.publisher ?? new InProcessEventPublisher();
  const fallbackAudit = deps.auditAppend ?? (async () => {});
  const nextEventId = deps.eventIdFactory ?? (() => randomUUID());

  const err = (reason: GenerationCommandErrorReason, message: string) => ({
    ok: false as const,
    error: { reason, message },
  });

  const isUUID = (v: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

  const optionalUUID = (v: string | null | undefined): string | null | undefined =>
    v === undefined || v === null ? v : v.length > 0 && isUUID(v) ? v : undefined;

  /**
   * Validate an optional UUID field: returns the normalized value
   * (undefined = absent, null = explicit null, string = validated UUID) or
   * an error result when the field was provided but is not a UUID.
   */
  const parseOptionalUUID = (
    raw: string | null | undefined,
    field: string,
  ): GenerationCommandResult<string | null | undefined> => {
    const normalized = optionalUUID(raw);
    if (normalized === undefined && raw !== undefined) {
      return err("invalid_request", `${field} must be a UUID when provided`);
    }
    return { ok: true, value: normalized };
  };

  const requireCapability = (actor: GenerationActor) =>
    actor.capabilities.includes(GENERATION_CAPABILITY)
      ? null
      : err("missing_capability", `${GENERATION_CAPABILITY} capability required`);

  const auditEntry = (
    actor: GenerationActor,
    action: string,
    targetId: string,
    metadata?: Record<string, unknown>,
  ): Parameters<GenerationAuditAppend>[0] => ({
    actorId: actor.operatorId,
    action,
    targetType: "generation",
    targetId,
    // D2.4-2: the acting operator's org scopes the audit record.
    organizationId: actor.organizationId,
    ...(metadata === undefined ? {} : { metadata }),
    correlationId: actor.correlationId ?? null,
    causationId: null,
  });

  /**
   * D2.4-1 dispatch (reused from the membership/production/jobs/catalog
   * services): run the mutation and its audit append inside ONE database
   * transaction when the repository supports it; otherwise fail closed
   * unless the test-only fallback flag is set.
   */
  const persistAndAudit = async <T>(
    actor: GenerationActor,
    action: string,
    describe: (value: T) => { targetId: string; metadata?: Record<string, unknown> },
    run: (tx: GenerationTransaction) => Promise<T>,
  ): Promise<T> => {
    if (repo.runInTransaction) {
      return repo.runInTransaction(async (tx) => {
        const value = await run(tx);
        const { targetId, metadata } = describe(value);
        await tx.appendAudit(auditEntry(actor, action, targetId, metadata));
        return value;
      });
    }
    if (deps.allowSequentialAudit !== true) {
      throw new Error(
        "D2.4-1 violation: repository does not implement runInTransaction; " +
          "generation mutations cannot commit without a same-transaction audit " +
          "record. (The sequential audit fallback is test-only and must be " +
          "enabled explicitly via allowSequentialAudit.)",
      );
    }
    const value = await run(directTx());
    const { targetId, metadata } = describe(value);
    await fallbackAudit(auditEntry(actor, action, targetId, metadata));
    return value;
  };

  const directTx = (): GenerationTransaction => ({
    insertGeneration: (input) => repo.insertGeneration(input),
    updateGeneration: (generationId, patch) => repo.updateGeneration(generationId, patch),
    insertProvenance: (input) => repo.insertProvenance(input),
    appendAudit: (entry) => fallbackAudit(entry),
  });

  const emit = async (
    name: "generation.created" | "generation.started" | "generation.completed" | "generation.failed" | "generation.cancelled",
    payload: Record<string, unknown>,
    correlation: { organizationId: string; productionId?: string | null },
  ) => {
    await emitEvent(publisher, {
      eventId: nextEventId(),
      name,
      correlation: {
        organizationId: correlation.organizationId,
        ...(correlation.productionId ? { productionId: correlation.productionId } : {}),
      },
      payload,
    });
  };

  const isTerminal = (status: GenerationStatus) => TERMINAL_GENERATION_STATUSES.includes(status);

  return {
    async requestGeneration(actor, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const orgId = actor.organizationId;

      if (!input.prompt || input.prompt.length > 8192) {
        return err("invalid_request", "prompt must be a non-empty string of at most 8192 characters");
      }
      if (input.modelId === undefined || !isUUID(input.modelId)) {
        return err("invalid_request", "modelId must be a UUID");
      }
      if (!input.modelVersion || input.modelVersion.length > 128) {
        return err("invalid_request", "modelVersion must be a non-empty string of at most 128 characters");
      }
      const workflowIdParsed = parseOptionalUUID(input.workflowId, "workflowId");
      if (!workflowIdParsed.ok) return workflowIdParsed;
      const workflowId = workflowIdParsed.value;
      if (input.workflowVersion !== undefined && input.workflowVersion !== null && input.workflowVersion.length > 128) {
        return err("invalid_request", "workflowVersion must be at most 128 characters when provided");
      }
      // Workflow selections are all-or-nothing: a version without its parent
      // id (or vice versa) cannot resolve — reject early (fail closed).
      // undefined (absent) and null (explicit none) are both "no selection".
      const hasWorkflowId = input.workflowId !== undefined && input.workflowId !== null;
      const hasWorkflowVersion = input.workflowVersion !== undefined && input.workflowVersion !== null;
      if (hasWorkflowId !== hasWorkflowVersion) {
        return err("invalid_request", "workflowId and workflowVersion must be provided together");
      }
      if (input.requestKey != null && (input.requestKey.length === 0 || input.requestKey.length > 512)) {
        return err("invalid_request", "requestKey must be a non-empty string of at most 512 characters");
      }
      const productionParsed = parseOptionalUUID(input.productionId, "productionId");
      if (!productionParsed.ok) return productionParsed;
      const productionId = productionParsed.value;
      const sceneParsed = parseOptionalUUID(input.sceneId, "sceneId");
      if (!sceneParsed.ok) return sceneParsed;
      const sceneId = sceneParsed.value;
      const shotParsed = parseOptionalUUID(input.shotId, "shotId");
      if (!shotParsed.ok) return shotParsed;
      const shotId = shotParsed.value;
      const parentParsed = parseOptionalUUID(input.parentGenerationId, "parentGenerationId");
      if (!parentParsed.ok) return parentParsed;
      const parentGenerationId = parentParsed.value;
      if (input.fps != null && (!Number.isInteger(input.fps) || input.fps <= 0)) {
        return err("invalid_request", "fps must be a positive integer when provided");
      }

      // Invariant 7 (API_ARCHITECTURE generation card): same (org, requestKey)
      // resolves to the EXISTING generation — a duplicate request is never an
      // error and never creates a second row.
      if (input.requestKey != null) {
        const existing = await repo.findGenerationByRequestKey(orgId, input.requestKey);
        if (existing) return { ok: true, value: { generation: existing, deduplicated: true } };
      }

      // Lineage validation: the parent must exist in the SAME organization;
      // cross-org parents are indistinguishable from absent ones (IDOR-safe).
      if (parentGenerationId != null) {
        const parent = await repo.findGenerationById(parentGenerationId);
        if (!parent || parent.orgId !== orgId) {
          return err("parent_not_found", "parent generation does not exist in your organization");
        }
      }

      // D2.8-3: FAIL-CLOSED Catalog resolution. The selection must resolve to
      // a durable Catalog version under the requesting organization and the
      // resolved version must not be `disabled` (deprecated versions remain
      // executable for historical reproducibility; disabled are not).
      const model = await deps.modelRegistry.findModel(orgId, input.modelId);
      if (!model || model.orgId !== orgId) {
        return err("model_not_found", "model does not exist in your organization");
      }
      const modelVersion = await deps.modelRegistry.resolveModelVersion(orgId, input.modelId, input.modelVersion);
      if (!modelVersion) return err("model_not_found", "model version does not exist in your organization");
      if (modelVersion.status === "disabled") return err("model_disabled", "model version is disabled");
      if (modelVersion.modelId !== input.modelId) {
        return err("model_not_found", "model version does not belong to the selected model");
      }

      let resolvedWorkflowVersionId: string | null = null;
      if (workflowId != null && input.workflowVersion != null) {
        const wf = await deps.workflowRegistry?.findWorkflow(orgId, workflowId);
        if (!wf || wf.orgId !== orgId) {
          return err("workflow_not_found", "workflow does not exist in your organization");
        }
        const wfVersion = await deps.workflowRegistry?.resolveWorkflowVersion(orgId, workflowId, input.workflowVersion);
        if (!wfVersion) return err("workflow_not_found", "workflow version does not exist in your organization");
        if (wfVersion.status === "disabled") return err("workflow_disabled", "workflow version is disabled");
        if (wfVersion.workflowId !== workflowId) {
          return err("workflow_not_found", "workflow version does not belong to the selected workflow");
        }
        resolvedWorkflowVersionId = wfVersion.id;
      }

      const generation = await persistAndAudit<GenerationRecord>(
        actor,
        "generations.generation_requested",
        (g) => ({
          targetId: g.id,
          metadata: {
            modelId: g.modelId,
            modelVersionId: g.modelVersionId,
            ...(g.workflowVersionId ? { workflowVersionId: g.workflowVersionId } : {}),
            ...(g.requestKey ? { requestKey: g.requestKey } : {}),
          },
        }),
        (tx) =>
          tx.insertGeneration({
            orgId,
            productionId: productionId ?? null,
            sceneId: sceneId ?? null,
            shotId: shotId ?? null,
            // D2.9-4: no wiring — the job reference is set by nobody here.
            jobId: null,
            parentGenerationId: parentGenerationId ?? null,
            // Pinned resolution (invariants 8/9): UUIDs, never strings.
            modelId: modelVersion.modelId,
            modelVersionId: modelVersion.id,
            workflowId: workflowId ?? null,
            workflowVersionId: resolvedWorkflowVersionId,
            inputAssetVersionIds: [...(input.inputAssetVersionIds ?? [])],
            prompt: input.prompt,
            negativePrompt: input.negativePrompt ?? null,
            seed: input.seed ?? null,
            parameters: input.parameters ?? {},
            resolution: input.resolution ?? null,
            fps: input.fps ?? null,
            durationSeconds: input.durationSeconds ?? null,
            adapters: [...(input.adapters ?? [])],
            estimatedCostUsd: input.estimatedCostUsd ?? null,
            requestKey: input.requestKey ?? null,
          }),
      );

      await emit(
        "generation.created",
        {
          generationId: generation.id,
          status: generation.status,
          modelVersionId: generation.modelVersionId,
          ...(generation.workflowVersionId ? { workflowVersionId: generation.workflowVersionId } : {}),
        },
        { organizationId: orgId, productionId: generation.productionId },
      );
      return { ok: true, value: { generation, deduplicated: false } };
    },

    async cancelGeneration(actor, generationId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const generation = await repo.findGenerationById(generationId);
      if (!generation || generation.orgId !== actor.organizationId) {
        // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
        return err("generation_not_found", "generation does not exist in your organization");
      }
      if (isTerminal(generation.status)) {
        return err("invalid_transition", `generation is already ${generation.status}`);
      }
      if (!GENERATION_TRANSITIONS[generation.status].includes("cancelled")) {
        return err("invalid_transition", `cannot cancel a ${generation.status} generation`);
      }
      const updated = await persistAndAudit<GenerationRecord>(
        actor,
        "generations.generation_cancelled",
        (g) => ({ targetId: g.id, metadata: { from: generation.status, to: g.status } }),
        (tx) => tx.updateGeneration(generation.id, { status: "cancelled" }),
      );
      await emit(
        "generation.cancelled",
        { generationId: updated.id, previousStatus: generation.status },
        { organizationId: actor.organizationId, productionId: updated.productionId },
      );
      return { ok: true, value: updated };
    },

    async startGeneration(generationId) {
      // Execution-path transition: lifecycle state ONLY. No worker, no
      // provider, no model execution exists in Stage 2.9.
      const generation = await repo.findGenerationById(generationId);
      if (!generation) return err("generation_not_found", "generation does not exist");
      if (generation.status !== "requested") {
        return err("invalid_transition", `only a requested generation can start (state: ${generation.status})`);
      }
      const updated = await repo.updateGeneration(generation.id, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await emit(
        "generation.started",
        { generationId: updated.id },
        { organizationId: updated.orgId, productionId: updated.productionId },
      );
      return { ok: true, value: updated };
    },

    async completeGeneration(generationId, input) {
      // Execution-path completion: the immutable provenance row and the
      // status transition commit in the SAME transaction (D2.9-1). The
      // provenance table's PRIMARY KEY is the one-shot guard — a second
      // completion of the same generation fails the whole transaction
      // (23505), leaving the generation untouched.
      const generation = await repo.findGenerationById(generationId);
      if (!generation) return err("generation_not_found", "generation does not exist");
      // One-shot completion guard (the database PK backs this at the
      // privilege layer): an existing provenance row means the generation
      // was already completed — reject BEFORE any state check so a duplicate
      // completion is always a conflict, never a silent second write.
      const existingProvenance = await repo.findProvenanceByGenerationId(generation.id);
      if (existingProvenance) {
        return err("completion_conflict", "generation already has completion provenance");
      }
      if (generation.status !== "running") {
        return err("invalid_transition", `only a running generation can complete (state: ${generation.status})`);
      }
      const runInTransaction = repo.runInTransaction;
      if (!runInTransaction) {
        throw new Error(
          "D2.4-1 violation: completion requires a transactional repository so the " +
            "provenance INSERT and the status transition commit atomically",
        );
      }
      const result = await runInTransaction(
        async (tx): Promise<{ generation: GenerationRecord; provenance: GenerationProvenanceRecord }> => {
          const provenance = await tx.insertProvenance({
            orgId: generation.orgId,
            generationId: generation.id,
            outputStorageKey: input.outputStorageKey ?? null,
            outputChecksum: input.outputChecksum ?? null,
            outputByteSize: input.outputByteSize ?? null,
            executedSeed: input.executedSeed ?? null,
            // Identifiers only — NEVER credentials (invariant 4).
            workerRef: input.workerRef ?? null,
            gpuClass: input.gpuClass ?? null,
            runtimeVersion: input.runtimeVersion ?? null,
            actualCostUsd: input.actualCostUsd ?? null,
            actualRuntimeSeconds: input.actualRuntimeSeconds ?? null,
          });
          const updated = await tx.updateGeneration(generation.id, {
            status: "completed",
            ...(input.outputAssetVersionId ? { outputAssetVersionId: input.outputAssetVersionId } : {}),
          });
          return { generation: updated, provenance };
        },
      );
      await emit(
        "generation.completed",
        {
          generationId: result.generation.id,
          provenanceId: result.provenance.generationId,
          ...(result.generation.outputAssetVersionId
            ? { outputAssetVersionId: result.generation.outputAssetVersionId }
            : {}),
        },
        { organizationId: result.generation.orgId, productionId: result.generation.productionId },
      );
      return { ok: true, value: result };
    },

    async failGeneration(generationId, input) {
      const generation = await repo.findGenerationById(generationId);
      if (!generation) return err("generation_not_found", "generation does not exist");
      if (generation.status !== "running") {
        return err("invalid_transition", `only a running generation can fail (state: ${generation.status})`);
      }
      if (!input.errorDetail || input.errorDetail.length > 2048) {
        return err("invalid_request", "errorDetail must be a non-empty string of at most 2048 characters");
      }
      const updated = await repo.updateGeneration(generation.id, {
        status: "failed",
        lastError: input.errorDetail,
      });
      await emit(
        "generation.failed",
        { generationId: updated.id, errorDetail: input.errorDetail },
        { organizationId: updated.orgId, productionId: updated.productionId },
      );
      return { ok: true, value: updated };
    },

    async getGeneration(actor, generationId) {
      const generation = await repo.findGenerationById(generationId);
      if (!generation || generation.orgId !== actor.organizationId) {
        return err("generation_not_found", "generation does not exist in your organization");
      }
      return { ok: true, value: generation };
    },

    async getProvenance(actor, generationId) {
      const generation = await repo.findGenerationById(generationId);
      if (!generation || generation.orgId !== actor.organizationId) {
        return err("generation_not_found", "generation does not exist in your organization");
      }
      const provenance = await repo.findProvenanceByGenerationId(generation.id);
      if (!provenance) {
        return err("generation_not_found", "generation has no completion provenance yet");
      }
      return { ok: true, value: { generation, provenance } };
    },

    async listGenerations(actor, filter) {
      return repo.listGenerationsByOrg(actor.organizationId, filter);
    },
  };
};
