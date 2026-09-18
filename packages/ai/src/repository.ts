/**
 * Durable model-registry adapter over @stratifit/database (Drizzle).
 *
 * Stage 2.8 Catalog Foundation (SERVICE_ARCHITECTURE section 11 context 8):
 * packages/ai owns the model registry's durable rows via packages/database.
 * All access is parameterized and org-scoped by the service; this adapter
 * executes exactly the statements it is given.
 *
 * D2.4-1 (reused): `runInTransaction` exposes the SAME transaction
 * connection to the mutations and the injected admin-audit writer, so a
 * registry mutation and its audit record commit atomically. The writer is a
 * structural type satisfied by `createAdminAuditService(...).transactionWriter()`
 * — admin-audit never opens a second connection.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  createDatabase,
  modelVersions,
  models,
  workflowVersions,
  workflows,
  type Database,
} from "@stratifit/database";
import type {
  CatalogRepository,
  CatalogTransaction,
  DrizzleCatalogRepositoryDeps,
  ModelRecord,
  ModelRegistryStatus,
  ModelVersionRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from "./types";

/** The mutating operations parameterized by executor (root OR transaction). */
const mutationsFor = (exec: Database): CatalogTransaction => ({
  insertModel: async (input) => {
    const [row] = await exec
      .insert(models)
      .values({
        orgId: input.orgId,
        name: input.name,
        capabilityKind: input.capabilityKind,
        displayName: input.displayName,
        vendorLabel: input.vendorLabel,
        status: input.status,
      })
      .returning();
    if (!row) throw new Error("model insert returned no row");
    return toModel(row);
  },
  updateModelStatus: async (modelId, status) => {
    const [row] = await exec
      .update(models)
      .set({ status, updatedAt: new Date() })
      .where(eq(models.id, modelId))
      .returning();
    if (!row) throw new Error("model status update returned no row");
    return toModel(row);
  },
  insertModelVersion: async (input) => {
    const [row] = await exec
      .insert(modelVersions)
      .values({
        orgId: input.orgId,
        modelId: input.modelId,
        version: input.version,
        adapterRef: input.adapterRef,
        compatibility: input.compatibility,
        defaultParameters: input.defaultParameters,
        status: input.status,
      })
      .returning();
    if (!row) throw new Error("model version insert returned no row");
    return toModelVersion(row);
  },
  insertWorkflow: async (input) => {
    const [row] = await exec
      .insert(workflows)
      .values({
        orgId: input.orgId,
        name: input.name,
        supports: [...input.supports],
        status: input.status,
      })
      .returning();
    if (!row) throw new Error("workflow insert returned no row");
    return toWorkflow(row);
  },
  updateWorkflowStatus: async (workflowId, status) => {
    const [row] = await exec
      .update(workflows)
      .set({ status, updatedAt: new Date() })
      .where(eq(workflows.id, workflowId))
      .returning();
    if (!row) throw new Error("workflow status update returned no row");
    return toWorkflow(row);
  },
  insertWorkflowVersion: async (input) => {
    const [row] = await exec
      .insert(workflowVersions)
      .values({
        orgId: input.orgId,
        workflowId: input.workflowId,
        version: input.version,
        runtimeRef: input.runtimeRef,
        definition: input.definition,
        compatibility: input.compatibility,
        status: input.status,
      })
      .returning();
    if (!row) throw new Error("workflow version insert returned no row");
    return toWorkflowVersion(row);
  },
  appendAudit: async () => {
    // Overridden in runInTransaction; direct-path audit is test-only and
    // wired by the service's sequential fallback, never by this adapter.
  },
});

const toModel = (row: typeof models.$inferSelect): ModelRecord => ({
  id: row.id,
  orgId: row.orgId,
  name: row.name,
  capabilityKind: row.capabilityKind,
  displayName: row.displayName,
  vendorLabel: row.vendorLabel,
  status: row.status as ModelRegistryStatus,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toModelVersion = (row: typeof modelVersions.$inferSelect): ModelVersionRecord => ({
  id: row.id,
  orgId: row.orgId,
  modelId: row.modelId,
  version: row.version,
  adapterRef: row.adapterRef,
  compatibility: row.compatibility,
  defaultParameters: row.defaultParameters,
  status: row.status as ModelRegistryStatus,
  registeredAt: row.registeredAt.toISOString(),
});

const toWorkflow = (row: typeof workflows.$inferSelect): WorkflowRecord => ({
  id: row.id,
  orgId: row.orgId,
  name: row.name,
  supports: row.supports,
  status: row.status as ModelRegistryStatus,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toWorkflowVersion = (row: typeof workflowVersions.$inferSelect): WorkflowVersionRecord => ({
  id: row.id,
  orgId: row.orgId,
  workflowId: row.workflowId,
  version: row.version,
  runtimeRef: row.runtimeRef,
  definition: row.definition,
  compatibility: row.compatibility,
  status: row.status as ModelRegistryStatus,
  registeredAt: row.registeredAt.toISOString(),
});

export const createCatalogRepository = (deps: DrizzleCatalogRepositoryDeps): CatalogRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db);

  return {
    async findModelById(id) {
      const [row] = await db.select().from(models).where(eq(models.id, id)).limit(1);
      return row ? toModel(row) : null;
    },
    async findModelByName(orgId, name) {
      const [row] = await db
        .select()
        .from(models)
        .where(and(eq(models.orgId, orgId), eq(models.name, name)))
        .limit(1);
      return row ? toModel(row) : null;
    },
    async listModelsByOrg(orgId, filter) {
      const conditions = [eq(models.orgId, orgId)];
      if (filter?.status !== undefined) conditions.push(eq(models.status, filter.status));
      if (filter?.capabilityKind !== undefined) conditions.push(eq(models.capabilityKind, filter.capabilityKind));
      const rows = await db
        .select()
        .from(models)
        .where(and(...conditions))
        .orderBy(asc(models.name));
      return rows.map(toModel);
    },
    async findModelVersion(orgId, modelId, version) {
      const [row] = await db
        .select()
        .from(modelVersions)
        .where(and(eq(modelVersions.orgId, orgId), eq(modelVersions.modelId, modelId), eq(modelVersions.version, version)))
        .limit(1);
      return row ? toModelVersion(row) : null;
    },
    async listModelVersions(modelId) {
      const rows = await db
        .select()
        .from(modelVersions)
        .where(eq(modelVersions.modelId, modelId))
        .orderBy(desc(modelVersions.registeredAt));
      return rows.map(toModelVersion);
    },
    async findWorkflowById(id) {
      const [row] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
      return row ? toWorkflow(row) : null;
    },
    async findWorkflowByName(orgId, name) {
      const [row] = await db
        .select()
        .from(workflows)
        .where(and(eq(workflows.orgId, orgId), eq(workflows.name, name)))
        .limit(1);
      return row ? toWorkflow(row) : null;
    },
    async listWorkflowsByOrg(orgId, filter) {
      const conditions = [eq(workflows.orgId, orgId)];
      if (filter?.status !== undefined) conditions.push(eq(workflows.status, filter.status));
      const rows = await db
        .select()
        .from(workflows)
        .where(and(...conditions))
        .orderBy(asc(workflows.name));
      return rows.map(toWorkflow);
    },
    async findWorkflowVersion(orgId, workflowId, version) {
      const [row] = await db
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.orgId, orgId),
            eq(workflowVersions.workflowId, workflowId),
            eq(workflowVersions.version, version),
          ),
        )
        .limit(1);
      return row ? toWorkflowVersion(row) : null;
    },
    async listWorkflowVersions(workflowId) {
      const rows = await db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowId, workflowId))
        .orderBy(desc(workflowVersions.registeredAt));
      return rows.map(toWorkflowVersion);
    },

    // Direct (non-transactional) mutations — the TEST-ONLY sequential
    // fallback path; the service prefers runInTransaction whenever it exists.
    insertModel: (input) => direct.insertModel(input),
    updateModelStatus: (modelId, status) => direct.updateModelStatus(modelId, status),
    insertModelVersion: (input) => direct.insertModelVersion(input),
    insertWorkflow: (input) => direct.insertWorkflow(input),
    updateWorkflowStatus: (workflowId, status) => direct.updateWorkflowStatus(workflowId, status),
    insertWorkflowVersion: (input) => direct.insertWorkflowVersion(input),

    /**
     * D2.4-1 (reused): the mutation and its audit record run on the SAME
     * transaction connection — a crash before COMMIT rolls back both, and
     * the mutation cannot commit without its audit row. The audit INSERT is
     * delegated to the injected admin-audit writer (structural type), which
     * executes on `tx` and never commits.
     */
    runInTransaction: async <T>(work: (tx: CatalogTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: CatalogTransaction = {
          ...mutations,
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};

export type DrizzleCatalogRepository = ReturnType<typeof createCatalogRepository>;
