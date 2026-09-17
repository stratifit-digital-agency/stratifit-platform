/**
 * Durable production-state adapter over @stratifit/database (Drizzle).
 *
 * Owns the production table family (SVC section 11 context 2): projects,
 * productions, production_plan_versions, gate_decision_records,
 * manifest_versions. All access is parameterized and org-scoped by the
 * service; this adapter executes exactly the statements it is given.
 *
 * D2.4-1 (reused from Stage 2.4): `runInTransaction` exposes the SAME
 * transaction connection to the domain mutations and the injected
 * `auditWriter`, so a security-critical mutation and its audit record commit
 * atomically. The writer is a structural type satisfied by
 * `createAdminAuditService(...).transactionWriter()` — admin-audit never
 * opens a second connection.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  createDatabase,
  gateDecisionRecords,
  manifestVersions,
  productionPlanVersions,
  productions,
  projects,
  type Database,
} from "@stratifit/database";
import type { ProductionManifest } from "@stratifit/contracts";
import type {
  GateDecisionRecord,
  GateDecisionValue,
  ManifestVersionRecord,
  PlanVersionRecord,
  ProductionAuditAppend,
  ProductionKind,
  ProductionRecord,
  ProductionRepository,
  ProductionStatus,
  ProductionTransaction,
  ProjectRecord,
} from "./types";

export interface DrizzleProductionRepositoryDeps {
  /** Existing Drizzle database (Control composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /**
   * D2.4-1 (required): the admin-audit transaction writer (structural type;
   * composition roots pass `createAdminAuditService(...).transactionWriter()`).
   */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<ProductionAuditAppend>[0]): Promise<void> };
}

const toProject = (row: typeof projects.$inferSelect): ProjectRecord => ({
  id: row.id,
  orgId: row.orgId,
  slug: row.slug,
  name: row.name,
  description: row.description,
  status: row.status as ProjectRecord["status"],
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const toProduction = (row: typeof productions.$inferSelect): ProductionRecord => ({
  id: row.id,
  orgId: row.orgId,
  projectId: row.projectId,
  title: row.title,
  kind: row.kind as ProductionKind,
  currentPlanVersionId: row.currentPlanVersionId,
  currentManifestVersionId: row.currentManifestVersionId,
  status: row.status as ProductionStatus,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toPlanVersion = (row: typeof productionPlanVersions.$inferSelect): PlanVersionRecord => ({
  id: row.id,
  orgId: row.orgId,
  productionId: row.productionId,
  versionNumber: row.versionNumber,
  planDocument: row.planDocument,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const toGateDecision = (row: typeof gateDecisionRecords.$inferSelect): GateDecisionRecord => ({
  id: row.id,
  orgId: row.orgId,
  productionId: row.productionId,
  planVersionId: row.planVersionId,
  decision: row.decision as GateDecisionValue,
  inputsSnapshot: row.inputsSnapshot,
  issues: (row.issues as unknown as GateDecisionRecord["issues"]) ?? [],
  evaluatedBy: row.evaluatedBy,
  evaluatedAt: row.evaluatedAt.toISOString(),
});

const toManifestVersion = (row: typeof manifestVersions.$inferSelect): ManifestVersionRecord => ({
  id: row.id,
  orgId: row.orgId,
  productionId: row.productionId,
  planVersionId: row.planVersionId,
  versionNumber: row.versionNumber,
  manifestDocument: row.manifestDocument as ProductionManifest,
  issuedBy: row.issuedBy,
  issuedAt: row.issuedAt.toISOString(),
});

/** The six mutating operations parameterized by executor (root OR transaction). */
const mutationsFor = (exec: Database) => ({
  insertProject: async (input: { orgId: string; slug: string; name: string; description?: string | null; createdBy: string }): Promise<ProjectRecord> => {
    const [row] = await exec
      .insert(projects)
      .values({
        orgId: input.orgId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("project insert returned no row");
    return toProject(row);
  },
  insertProduction: async (input: { orgId: string; projectId: string; title: string; kind: ProductionKind }): Promise<ProductionRecord> => {
    const [row] = await exec
      .insert(productions)
      .values({
        orgId: input.orgId,
        projectId: input.projectId,
        title: input.title,
        kind: input.kind,
      })
      .returning();
    if (!row) throw new Error("production insert returned no row");
    return toProduction(row);
  },
  insertPlanVersion: async (input: { orgId: string; productionId: string; versionNumber: number; planDocument: Record<string, unknown>; createdBy: string }): Promise<PlanVersionRecord> => {
    const [row] = await exec
      .insert(productionPlanVersions)
      .values({
        orgId: input.orgId,
        productionId: input.productionId,
        versionNumber: input.versionNumber,
        planDocument: input.planDocument,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("plan version insert returned no row");
    return toPlanVersion(row);
  },
  updateProduction: async (productionId: string, patch: { status?: ProductionStatus; currentPlanVersionId?: string | null; currentManifestVersionId?: string | null }): Promise<ProductionRecord> => {
    const [row] = await exec
      .update(productions)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.currentPlanVersionId !== undefined ? { currentPlanVersionId: patch.currentPlanVersionId } : {}),
        ...(patch.currentManifestVersionId !== undefined ? { currentManifestVersionId: patch.currentManifestVersionId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(productions.id, productionId))
      .returning();
    if (!row) throw new Error("production update returned no row");
    return toProduction(row);
  },
  insertGateDecision: async (input: { orgId: string; productionId: string; planVersionId: string; decision: GateDecisionValue; inputsSnapshot: Record<string, unknown>; issues: readonly { code: string; message: string }[]; evaluatedBy: string }): Promise<GateDecisionRecord> => {
    const [row] = await exec
      .insert(gateDecisionRecords)
      .values({
        orgId: input.orgId,
        productionId: input.productionId,
        planVersionId: input.planVersionId,
        decision: input.decision,
        inputsSnapshot: input.inputsSnapshot,
        issues: input.issues.map((i) => ({ code: i.code, message: i.message })) as unknown as Record<string, unknown>[],
        evaluatedBy: input.evaluatedBy,
      })
      .returning();
    if (!row) throw new Error("gate decision insert returned no row");
    return toGateDecision(row);
  },
  insertManifestVersion: async (input: { orgId: string; productionId: string; planVersionId: string; versionNumber: number; manifestDocument: ProductionManifest; issuedBy: string }): Promise<ManifestVersionRecord> => {
    const [row] = await exec
      .insert(manifestVersions)
      .values({
        orgId: input.orgId,
        productionId: input.productionId,
        planVersionId: input.planVersionId,
        versionNumber: input.versionNumber,
        manifestDocument: input.manifestDocument as unknown as Record<string, unknown>,
        issuedBy: input.issuedBy,
      })
      .returning();
    if (!row) throw new Error("manifest version insert returned no row");
    return toManifestVersion(row);
  },
});

export const createDrizzleProductionRepository = (
  deps: DrizzleProductionRepositoryDeps,
): ProductionRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db);

  return {
    async findProjectBySlug(orgId, slug) {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug)))
        .limit(1);
      return row ? toProject(row) : null;
    },

    async findProjectById(id) {
      const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return row ? toProject(row) : null;
    },

    async listProjectsByOrg(orgId) {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.orgId, orgId))
        .orderBy(asc(projects.slug));
      return rows.map(toProject);
    },

    async findProductionById(id) {
      const [row] = await db.select().from(productions).where(eq(productions.id, id)).limit(1);
      return row ? toProduction(row) : null;
    },

    async listProductionsByOrg(orgId) {
      const rows = await db
        .select()
        .from(productions)
        .where(eq(productions.orgId, orgId))
        .orderBy(desc(productions.createdAt));
      return rows.map(toProduction);
    },

    async listProductionsByProject(projectId) {
      const rows = await db
        .select()
        .from(productions)
        .where(eq(productions.projectId, projectId))
        .orderBy(desc(productions.createdAt));
      return rows.map(toProduction);
    },

    async findPlanVersionById(id) {
      const [row] = await db
        .select()
        .from(productionPlanVersions)
        .where(eq(productionPlanVersions.id, id))
        .limit(1);
      return row ? toPlanVersion(row) : null;
    },

    async findLatestPlanVersion(productionId) {
      const [row] = await db
        .select()
        .from(productionPlanVersions)
        .where(eq(productionPlanVersions.productionId, productionId))
        .orderBy(desc(productionPlanVersions.versionNumber))
        .limit(1);
      return row ? toPlanVersion(row) : null;
    },

    async findPassingGateDecision(productionId, planVersionId) {
      const [row] = await db
        .select()
        .from(gateDecisionRecords)
        .where(
          and(
            eq(gateDecisionRecords.productionId, productionId),
            eq(gateDecisionRecords.planVersionId, planVersionId),
            eq(gateDecisionRecords.decision, "pass"),
          ),
        )
        .orderBy(desc(gateDecisionRecords.evaluatedAt))
        .limit(1);
      return row ? toGateDecision(row) : null;
    },

    async findLatestManifestVersion(productionId) {
      const [row] = await db
        .select()
        .from(manifestVersions)
        .where(eq(manifestVersions.productionId, productionId))
        .orderBy(desc(manifestVersions.versionNumber))
        .limit(1);
      return row ? toManifestVersion(row) : null;
    },

    // Direct (non-transactional) mutations — the TEST-ONLY sequential
    // fallback path mirrors MembershipRepository; the service prefers
    // runInTransaction whenever it exists.
    insertProject: (input) => direct.insertProject(input),
    insertProduction: (input) => direct.insertProduction(input),
    insertPlanVersion: (input) => direct.insertPlanVersion(input),
    updateProduction: (productionId, patch) => direct.updateProduction(productionId, patch),
    insertGateDecision: (input) => direct.insertGateDecision(input),
    insertManifestVersion: (input) => direct.insertManifestVersion(input),

    /**
     * D2.4-1 (reused): the production mutation and its audit record run on
     * the SAME transaction connection — a crash before COMMIT rolls back
     * both, and the mutation cannot commit without its audit row. The audit
     * INSERT is delegated to the injected admin-audit writer (structural
     * type), which executes on `tx` and never commits.
     */
    runInTransaction: async <T>(work: (tx: ProductionTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: ProductionTransaction = {
          insertProject: (input) => mutations.insertProject(input),
          insertProduction: (input) => mutations.insertProduction(input),
          insertPlanVersion: (input) => mutations.insertPlanVersion(input),
          updateProduction: (productionId, patch) => mutations.updateProduction(productionId, patch),
          insertGateDecision: (input) => mutations.insertGateDecision(input),
          insertManifestVersion: (input) => mutations.insertManifestVersion(input),
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};
