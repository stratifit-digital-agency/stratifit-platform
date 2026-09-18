/**
 * Durable workflow-registry adapter over @stratifit/database (Drizzle).
 *
 * Stage 2.8 Catalog Foundation (SERVICE_ARCHITECTURE section 11 context 8):
 * packages/workflows owns the workflow registry's durable rows via
 * packages/database. All access is parameterized and org-scoped by the
 * service; this adapter executes exactly the statements it is given.
 *
 * D2.4-1 (reused): `runInTransaction` exposes the SAME transaction
 * connection to the mutations and the injected admin-audit writer, so a
 * registry mutation and its audit record commit atomically.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  createDatabase,
  workflowVersions,
  workflows,
  type Database,
} from "@stratifit/database";
import type {
  DrizzleWorkflowCatalogRepositoryDeps,
  WorkflowCatalogRecord,
  WorkflowCatalogRepository,
  WorkflowCatalogTransaction,
  WorkflowRegistryStatus,
  WorkflowVersionRecord,
} from "./types";

const toWorkflow = (row: typeof workflows.$inferSelect): WorkflowCatalogRecord => ({
  id: row.id,
  orgId: row.orgId,
  name: row.name,
  supports: row.supports,
  status: row.status as WorkflowRegistryStatus,
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
  status: row.status as WorkflowRegistryStatus,
  registeredAt: row.registeredAt.toISOString(),
});

/** The mutating operations parameterized by executor (root OR transaction). */
const mutationsFor = (exec: Database): WorkflowCatalogTransaction => ({
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

export const createWorkflowCatalogRepository = (
  deps: DrizzleWorkflowCatalogRepositoryDeps,
): WorkflowCatalogRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db);

  return {
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
    insertWorkflow: (input) => direct.insertWorkflow(input),
    updateWorkflowStatus: (workflowId, status) => direct.updateWorkflowStatus(workflowId, status),
    insertWorkflowVersion: (input) => direct.insertWorkflowVersion(input),

    /**
     * D2.4-1 (reused): the mutation and its audit record run on the SAME
     * transaction connection — a crash before COMMIT rolls back both, and
     * the mutation cannot commit without its audit row.
     */
    runInTransaction: async <T>(work: (tx: WorkflowCatalogTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: WorkflowCatalogTransaction = {
          ...mutations,
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};
