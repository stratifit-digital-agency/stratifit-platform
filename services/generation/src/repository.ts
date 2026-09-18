/**
 * Durable generation-state adapter over @stratifit/database (Drizzle).
 *
 * Owns the generation table family (SVC section 11 context 7): generations,
 * generation_provenance. All access is parameterized and org-scoped by the
 * service; this adapter executes exactly the statements it is given.
 *
 * D2.4-1 (reused from Stage 2.4): `runInTransaction` exposes the SAME
 * transaction connection to the domain mutations and the injected
 * `auditWriter`, so an actor-originated mutation and its audit record commit
 * atomically. The writer is a structural type satisfied by
 * `createAdminAuditService(...).transactionWriter()` — admin-audit never
 * opens a second connection.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  createDatabase,
  generationProvenance,
  generations,
  type Database,
} from "@stratifit/database";
import type {
  GenerationAuditAppend,
  GenerationCommandErrorReason,
  GenerationCommandResult,
  GenerationProvenanceRecord,
  GenerationRecord,
  GenerationRepository,
  GenerationStatus,
  GenerationTransaction,
} from "./types";

export interface DrizzleGenerationRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /**
   * D2.4-1 (required): the admin-audit transaction writer (structural type;
   * composition roots pass `createAdminAuditService(...).transactionWriter()`).
   */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<GenerationAuditAppend>[0]): Promise<void> };
}

const toGeneration = (row: typeof generations.$inferSelect): GenerationRecord => ({
  id: row.id,
  orgId: row.orgId,
  status: row.status as GenerationStatus,
  productionId: row.productionId,
  sceneId: row.sceneId,
  shotId: row.shotId,
  jobId: row.jobId,
  outputAssetVersionId: row.outputAssetVersionId,
  modelId: row.modelId,
  modelVersionId: row.modelVersionId,
  workflowId: row.workflowId,
  workflowVersionId: row.workflowVersionId,
  parentGenerationId: row.parentGenerationId,
  inputAssetVersionIds: row.inputAssetVersionIds,
  prompt: row.prompt,
  negativePrompt: row.negativePrompt,
  seed: row.seed,
  parameters: row.parameters,
  resolution: row.resolution,
  fps: row.fps,
  durationSeconds: row.durationSeconds,
  adapters: row.adapters,
  estimatedCostUsd: row.estimatedCostUsd,
  requestKey: row.requestKey,
  lastError: row.lastError,
  requestedAt: row.requestedAt.toISOString(),
  startedAt: row.startedAt ? row.startedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toProvenance = (row: typeof generationProvenance.$inferSelect): GenerationProvenanceRecord => ({
  generationId: row.generationId,
  orgId: row.orgId,
  outputStorageKey: row.outputStorageKey,
  outputChecksum: row.outputChecksum,
  outputByteSize: row.outputByteSize,
  executedSeed: row.executedSeed,
  workerRef: row.workerRef,
  gpuClass: row.gpuClass,
  runtimeVersion: row.runtimeVersion,
  actualCostUsd: row.actualCostUsd,
  actualRuntimeSeconds: row.actualRuntimeSeconds,
  completedAt: row.completedAt.toISOString(),
});

/** The three mutating operations parameterized by executor (root OR transaction). */
const mutationsFor = (exec: Database) => ({
  insertGeneration: async (input: Parameters<GenerationTransaction["insertGeneration"]>[0]): Promise<GenerationRecord> => {
    const [row] = await exec
      .insert(generations)
      .values({
        orgId: input.orgId,
        productionId: input.productionId,
        sceneId: input.sceneId,
        shotId: input.shotId,
        jobId: input.jobId,
        parentGenerationId: input.parentGenerationId,
        modelId: input.modelId,
        modelVersionId: input.modelVersionId,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        inputAssetVersionIds: [...input.inputAssetVersionIds],
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        seed: input.seed,
        parameters: input.parameters,
        resolution: input.resolution,
        fps: input.fps,
        durationSeconds: input.durationSeconds,
        adapters: [...input.adapters],
        estimatedCostUsd: input.estimatedCostUsd,
        requestKey: input.requestKey,
      })
      .returning();
    if (!row) throw new Error("generation insert returned no row");
    return toGeneration(row);
  },
  updateGeneration: async (
    generationId: string,
    patch: Parameters<GenerationTransaction["updateGeneration"]>[1],
  ): Promise<GenerationRecord> => {
    // ONLY the approved mutable columns are ever written: status, startedAt,
    // lastError, outputAssetVersionId. Request provenance columns are absent
    // from this patch by construction (invariant 3: request provenance is
    // INSERT-only; corrections are superseding generations, never edits).
    const [row] = await exec
      .update(generations)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt === null ? null : new Date(patch.startedAt) } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.outputAssetVersionId !== undefined ? { outputAssetVersionId: patch.outputAssetVersionId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(generations.id, generationId))
      .returning();
    if (!row) throw new Error("generation update returned no row");
    return toGeneration(row);
  },
  insertProvenance: async (
    input: Parameters<GenerationTransaction["insertProvenance"]>[0],
  ): Promise<GenerationProvenanceRecord> => {
    // generation_id is the PRIMARY KEY of generation_provenance — the
    // one-shot completion guard lives in the database itself: a second
    // completion of the same generation hits the unique constraint (23505).
    const [row] = await exec
      .insert(generationProvenance)
      .values({
        generationId: input.generationId,
        orgId: input.orgId,
        outputStorageKey: input.outputStorageKey,
        outputChecksum: input.outputChecksum,
        outputByteSize: input.outputByteSize,
        executedSeed: input.executedSeed,
        workerRef: input.workerRef,
        gpuClass: input.gpuClass,
        runtimeVersion: input.runtimeVersion,
        actualCostUsd: input.actualCostUsd,
        actualRuntimeSeconds: input.actualRuntimeSeconds,
      })
      .returning();
    if (!row) throw new Error("generation provenance insert returned no row");
    return toProvenance(row);
  },
});

export const createGenerationRepository = (
  deps: DrizzleGenerationRepositoryDeps,
): GenerationRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db);

  return {
    async findGenerationById(id) {
      const [row] = await db.select().from(generations).where(eq(generations.id, id)).limit(1);
      return row ? toGeneration(row) : null;
    },

    async findGenerationByRequestKey(orgId, requestKey) {
      const [row] = await db
        .select()
        .from(generations)
        .where(and(eq(generations.orgId, orgId), eq(generations.requestKey, requestKey)))
        .limit(1);
      return row ? toGeneration(row) : null;
    },

    async findProvenanceByGenerationId(generationId) {
      const [row] = await db
        .select()
        .from(generationProvenance)
        .where(eq(generationProvenance.generationId, generationId))
        .limit(1);
      return row ? toProvenance(row) : null;
    },

    async listGenerationsByOrg(orgId, filter) {
      const conditions = [eq(generations.orgId, orgId)];
      if (filter?.status !== undefined) conditions.push(eq(generations.status, filter.status));
      if (filter?.productionId !== undefined) conditions.push(eq(generations.productionId, filter.productionId));
      const rows = await db
        .select()
        .from(generations)
        .where(and(...conditions))
        .orderBy(desc(generations.createdAt));
      return rows.map(toGeneration);
    },

    insertGeneration: (input) => direct.insertGeneration(input),
    updateGeneration: (generationId, patch) => direct.updateGeneration(generationId, patch),
    insertProvenance: (input) => direct.insertProvenance(input),

    /**
     * D2.4-1 (reused): the mutation and its audit record run on the SAME
     * transaction connection — a crash before COMMIT rolls back both, and
     * the mutation cannot commit without its audit row. The audit INSERT is
     * delegated to the injected admin-audit writer (structural type), which
     * executes on `tx` and never commits.
     */
    runInTransaction: async <T>(work: (tx: GenerationTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: GenerationTransaction = {
          insertGeneration: (input) => mutations.insertGeneration(input),
          updateGeneration: (generationId, patch) => mutations.updateGeneration(generationId, patch),
          insertProvenance: (input) => mutations.insertProvenance(input),
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};

/** Classified-error helper shared by the service (kept near the adapter). */
export const generationError = (
  reason: GenerationCommandErrorReason,
  message: string,
): GenerationCommandResult<never> => ({ ok: false as const, error: { reason, message } });
