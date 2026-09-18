/**
 * Durable asset-state adapter over @stratifit/database (Drizzle).
 *
 * Owns the asset table family (SVC section 11 context 6): assets,
 * asset_versions, asset_lineage. All access is parameterized and org-scoped
 * by the service; this adapter executes exactly the statements it is given.
 *
 * D2.4-1 (reused from Stage 2.4): `runInTransaction` exposes the SAME
 * transaction connection to the domain mutations and the injected
 * `auditWriter`, so an operator-originated mutation and its audit record
 * commit atomically. The writer is a structural type satisfied by
 * `createAdminAuditService(...).transactionWriter()` — admin-audit never
 * opens a second connection.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  assetLineage,
  assetVersions,
  assets,
  createDatabase,
  type Database,
} from "@stratifit/database";
import type {
  AssetApprovalState,
  AssetAuditAppend,
  AssetDerivationKind,
  AssetKind,
  AssetLineageRecord,
  AssetRecord,
  AssetRepository,
  AssetSubtype,
  AssetTransaction,
  AssetVersionRecord,
  AssetVisibility,
} from "./types";

export interface DrizzleAssetRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /**
   * D2.4-1 (required): the admin-audit transaction writer (structural type;
   * composition roots pass `createAdminAuditService(...).transactionWriter()`).
   */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<AssetAuditAppend>[0]): Promise<void> };
}

const toAsset = (row: typeof assets.$inferSelect): AssetRecord => ({
  id: row.id,
  orgId: row.orgId,
  kind: row.kind as AssetKind,
  subtype: (row.subtype ?? null) as AssetSubtype | null,
  title: row.title,
  description: row.description,
  currentVersionId: row.currentVersionId,
  approvalState: row.approvalState as AssetApprovalState,
  visibility: row.visibility as AssetVisibility,
  productionId: row.productionId,
  shotId: row.shotId,
  tags: row.tags,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toVersion = (row: typeof assetVersions.$inferSelect): AssetVersionRecord => ({
  id: row.id,
  orgId: row.orgId,
  assetId: row.assetId,
  versionNumber: row.versionNumber,
  bucket: row.bucket,
  storageKey: row.storageKey,
  checksum: row.checksum,
  byteSize: Number(row.byteSize),
  mimeType: row.mimeType,
  technicalMetadata: row.technicalMetadata,
  provenanceGenerationId: row.provenanceGenerationId,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const toLineage = (row: typeof assetLineage.$inferSelect): AssetLineageRecord => ({
  id: row.id,
  orgId: row.orgId,
  parentVersionId: row.parentVersionId,
  childVersionId: row.childVersionId,
  derivationKind: row.derivationKind as AssetDerivationKind,
  createdAt: row.createdAt.toISOString(),
});

/** The four mutating operations parameterized by executor (root OR transaction). */
const mutationsFor = (exec: Database) => ({
  insertAsset: async (input: Parameters<AssetTransaction["insertAsset"]>[0]): Promise<AssetRecord> => {
    const [row] = await exec
      .insert(assets)
      .values({
        orgId: input.orgId,
        kind: input.kind,
        subtype: input.subtype,
        title: input.title,
        description: input.description,
        productionId: input.productionId,
        shotId: input.shotId,
        tags: [...input.tags],
      })
      .returning();
    if (!row) throw new Error("asset insert returned no row");
    return toAsset(row);
  },
  updateAsset: async (
    assetId: string,
    patch: Parameters<AssetTransaction["updateAsset"]>[1],
  ): Promise<AssetRecord> => {
    // ONLY the approved mutable columns are ever written. asset_versions and
    // asset_lineage are untouched here (immutability), and the current-
    // version pointer is set by the version-registration flow only.
    const [row] = await exec
      .update(assets)
      .set({
        ...(patch.approvalState !== undefined ? { approvalState: patch.approvalState } : {}),
        ...(patch.currentVersionId !== undefined ? { currentVersionId: patch.currentVersionId } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId))
      .returning();
    if (!row) throw new Error("asset update returned no row");
    return toAsset(row);
  },
  insertAssetVersion: async (
    input: Parameters<AssetTransaction["insertAssetVersion"]>[0],
  ): Promise<AssetVersionRecord> => {
    // The (org, asset, version) UNIQUE constraint is the duplicate-version
    // backstop — a concurrent duplicate hits 23505, never a silent second row.
    const [row] = await exec
      .insert(assetVersions)
      .values({
        orgId: input.orgId,
        assetId: input.assetId,
        versionNumber: input.versionNumber,
        bucket: input.bucket,
        storageKey: input.storageKey,
        checksum: input.checksum,
        byteSize: input.byteSize,
        mimeType: input.mimeType,
        technicalMetadata: input.technicalMetadata,
        provenanceGenerationId: input.provenanceGenerationId,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("asset version insert returned no row");
    return toVersion(row);
  },
  insertLineageEdge: async (
    input: Parameters<AssetTransaction["insertLineageEdge"]>[0],
  ): Promise<AssetLineageRecord> => {
    // The (parent, child) UNIQUE constraint is the duplicate-edge backstop
    // (23505); the no-self-edge CHECK rejects self edges at the database.
    const [row] = await exec
      .insert(assetLineage)
      .values({
        orgId: input.orgId,
        parentVersionId: input.parentVersionId,
        childVersionId: input.childVersionId,
        derivationKind: input.derivationKind,
      })
      .returning();
    if (!row) throw new Error("asset lineage insert returned no row");
    return toLineage(row);
  },
});

export const createAssetRepository = (deps: DrizzleAssetRepositoryDeps): AssetRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db);

  return {
    async findAssetById(id) {
      const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
      return row ? toAsset(row) : null;
    },

    async findVersionById(id) {
      const [row] = await db.select().from(assetVersions).where(eq(assetVersions.id, id)).limit(1);
      return row ? toVersion(row) : null;
    },

    async findVersionByNumber(orgId, assetId, versionNumber) {
      const [row] = await db
        .select()
        .from(assetVersions)
        .where(and(eq(assetVersions.orgId, orgId), eq(assetVersions.assetId, assetId), eq(assetVersions.versionNumber, versionNumber)))
        .limit(1);
      return row ? toVersion(row) : null;
    },

    async listVersionsByAsset(orgId, assetId) {
      const rows = await db
        .select()
        .from(assetVersions)
        .where(and(eq(assetVersions.orgId, orgId), eq(assetVersions.assetId, assetId)))
        .orderBy(asc(assetVersions.versionNumber));
      return rows.map(toVersion);
    },

    async findLineageEdge(orgId, parentVersionId, childVersionId) {
      const [row] = await db
        .select()
        .from(assetLineage)
        .where(
          and(
            eq(assetLineage.orgId, orgId),
            eq(assetLineage.parentVersionId, parentVersionId),
            eq(assetLineage.childVersionId, childVersionId),
          ),
        )
        .limit(1);
      return row ? toLineage(row) : null;
    },

    /** D2.10-5: single-hop only — direct parents of one version. */
    async listParentEdges(orgId, childVersionId) {
      const rows = await db
        .select()
        .from(assetLineage)
        .where(and(eq(assetLineage.orgId, orgId), eq(assetLineage.childVersionId, childVersionId)));
      return rows.map(toLineage);
    },

    /** D2.10-5: single-hop only — direct children of one version. */
    async listChildEdges(orgId, parentVersionId) {
      const rows = await db
        .select()
        .from(assetLineage)
        .where(and(eq(assetLineage.orgId, orgId), eq(assetLineage.parentVersionId, parentVersionId)));
      return rows.map(toLineage);
    },

    async listAssetsByOrg(orgId, filter) {
      const conditions = [eq(assets.orgId, orgId)];
      if (filter?.kind !== undefined) conditions.push(eq(assets.kind, filter.kind));
      if (filter?.approvalState !== undefined) conditions.push(eq(assets.approvalState, filter.approvalState));
      const rows = await db
        .select()
        .from(assets)
        .where(and(...conditions))
        .orderBy(desc(assets.createdAt));
      return rows.map(toAsset);
    },

    insertAsset: (input) => direct.insertAsset(input),
    updateAsset: (assetId, patch) => direct.updateAsset(assetId, patch),
    insertAssetVersion: (input) => direct.insertAssetVersion(input),
    insertLineageEdge: (input) => direct.insertLineageEdge(input),

    /**
     * D2.4-1 (reused): the mutation and its audit record run on the SAME
     * transaction connection — a crash before COMMIT rolls back both, and
     * the mutation cannot commit without its audit row. The audit INSERT is
     * delegated to the injected admin-audit writer (structural type), which
     * executes on `tx` and never commits.
     */
    runInTransaction: async <T>(work: (tx: AssetTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: AssetTransaction = {
          insertAsset: (input) => mutations.insertAsset(input),
          updateAsset: (assetId, patch) => mutations.updateAsset(assetId, patch),
          insertAssetVersion: (input) => mutations.insertAssetVersion(input),
          insertLineageEdge: (input) => mutations.insertLineageEdge(input),
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};
