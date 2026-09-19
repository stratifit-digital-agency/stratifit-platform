/**
 * Durable publishing-state adapter over @stratifit/database (Drizzle).
 *
 * Owns the Publishing table family (SVC section 11 context 11):
 * publications, publication_versions, distribution_references. All access
 * is parameterized and org-scoped by the service; this adapter executes
 * exactly the statements it is given.
 *
 * D2.4-1 (reused from Stages 2.4–2.11): `runInTransaction` exposes the SAME
 * transaction connection to the domain mutations and the injected
 * `auditWriter`, so an operator-originated mutation and its audit record
 * commit atomically. The writer is a structural type satisfied by
 * `createAdminAuditService(...).transactionWriter()` — admin-audit never
 * opens a second connection.
 *
 * Immutability is enforced by the PRIVILEGE layer (0024 grants the immutable
 * families INSERT+SELECT only); this adapter declares no update/delete
 * repository paths for publication_versions or distribution_references at
 * all.
 */
import { and, asc, eq } from "drizzle-orm";
import {
  createDatabase,
  distributionReferences,
  publicationVersions,
  publications,
  type Database,
} from "@stratifit/database";
import type {
  DistributionReferenceInsertRow,
  DistributionReferenceRecord,
  PublicationCreateRow,
  PublicationRecordView,
  PublicationUpdatePatch,
  PublicationVersionInsertRow,
  PublicationVersionRecord,
  PublishingAuditAppend,
  PublishingRepository,
  PublishingTransaction,
} from "./types";

export interface DrizzlePublishingRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /**
   * D2.4-1 (required): the admin-audit transaction writer (structural type;
   * composition roots pass `createAdminAuditService(...).transactionWriter()`).
   */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<PublishingAuditAppend>[0]): Promise<void> };
}

const toPublication = (row: typeof publications.$inferSelect): PublicationRecordView => ({
  id: row.id,
  orgId: row.orgId,
  subjectKind: row.subjectKind as PublicationRecordView["subjectKind"],
  subjectRef: row.subjectRef,
  platformTarget: row.platformTarget as PublicationRecordView["platformTarget"],
  contentType: row.contentType as PublicationRecordView["contentType"],
  currentVersionId: row.currentVersionId,
  qcReviewId: row.qcReviewId,
  status: row.status as PublicationRecordView["status"],
  scheduledFor: row.scheduledFor ? row.scheduledFor.toISOString() : null,
  attemptCount: row.attemptCount,
  lastFailureReason: row.lastFailureReason,
  lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toVersion = (row: typeof publicationVersions.$inferSelect): PublicationVersionRecord => ({
  id: row.id,
  orgId: row.orgId,
  publicationId: row.publicationId,
  versionNumber: row.versionNumber,
  title: row.title,
  synopsis: row.synopsis,
  contentType: row.contentType as PublicationVersionRecord["contentType"],
  subjectKind: row.subjectKind as PublicationVersionRecord["subjectKind"],
  subjectRef: row.subjectRef,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const toDistributionReference = (row: typeof distributionReferences.$inferSelect): DistributionReferenceRecord => ({
  id: row.id,
  orgId: row.orgId,
  publicationId: row.publicationId,
  versionId: row.versionId,
  platformTarget: row.platformTarget as DistributionReferenceRecord["platformTarget"],
  externalRef: row.externalRef,
  deliveryOutcome: row.deliveryOutcome as DistributionReferenceRecord["deliveryOutcome"],
  failureReason: row.failureReason,
  createdAt: row.createdAt.toISOString(),
});

/** The mutating operations parameterized by executor (root OR transaction). */
const mutationsFor = (exec: Database) => ({
  findPublicationById: async (orgId: string, publicationId: string): Promise<PublicationRecordView | null> => {
    const [row] = await exec
      .select()
      .from(publications)
      .where(and(eq(publications.id, publicationId), eq(publications.orgId, orgId)))
      .limit(1);
    return row ? toPublication(row) : null;
  },
  insertPublication: async (input: PublicationCreateRow): Promise<PublicationRecordView> => {
    const [row] = await exec
      .insert(publications)
      .values({
        orgId: input.orgId,
        subjectKind: input.subjectKind,
        subjectRef: input.subjectRef,
        platformTarget: input.platformTarget,
        contentType: input.contentType,
        status: input.status,
        ...(input.qcReviewId !== undefined && input.qcReviewId !== null ? { qcReviewId: input.qcReviewId } : {}),
      })
      .onConflictDoNothing({ target: [publications.orgId, publications.subjectKind, publications.subjectRef, publications.platformTarget] })
      .returning();
    // Deterministic dedupe signal: a conflicting insert returns no row.
    return row ? toPublication(row) : (null as unknown as PublicationRecordView);
  },
  updatePublication: async (publicationId: string, patch: PublicationUpdatePatch): Promise<PublicationRecordView> => {
    const toTs = (v: string | null | undefined): Date | null | undefined =>
      v === undefined ? undefined : v === null ? null : new Date(v);
    const { qcReviewId, ...rest } = patch;
    const [row] = await exec
      .update(publications)
      .set({
        ...rest,
        ...(qcReviewId !== undefined ? { qcReviewId } : {}),
        scheduledFor: toTs(patch.scheduledFor),
        lastAttemptAt: toTs(patch.lastAttemptAt),
        updatedAt: new Date(),
      })
      .where(eq(publications.id, publicationId))
      .returning();
    if (!row) throw new Error("publication update returned no row");
    return toPublication(row);
  },
  insertVersion: async (input: PublicationVersionInsertRow): Promise<PublicationVersionRecord> => {
    const [row] = await exec.insert(publicationVersions).values(input).returning();
    if (!row) throw new Error("publication version insert returned no row");
    return toVersion(row);
  },
  insertDistributionReference: async (
    input: DistributionReferenceInsertRow,
  ): Promise<DistributionReferenceRecord> => {
    const [row] = await exec.insert(distributionReferences).values(input).returning();
    if (!row) throw new Error("distribution reference insert returned no row");
    return toDistributionReference(row);
  },
  appendAudit: (entry: Parameters<PublishingAuditAppend>[0]): Promise<void> => {
    throw new Error("audit appends require an active transaction (D2.4-1)");
  },
});

export const createDrizzlePublishingRepository = (
  deps: DrizzlePublishingRepositoryDeps,
): PublishingRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);

  const direct = mutationsFor(db);

  return {
    async findPublicationById(orgId, publicationId) {
      const [row] = await db
        .select()
        .from(publications)
        .where(and(eq(publications.id, publicationId), eq(publications.orgId, orgId)))
        .limit(1);
      return row ? toPublication(row) : null;
    },

    async findPublicationBySubject(orgId, subjectKind, subjectRef, platformTarget) {
      const [row] = await db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.orgId, orgId),
            eq(publications.subjectKind, subjectKind),
            eq(publications.subjectRef, subjectRef),
            eq(publications.platformTarget, platformTarget),
          ),
        )
        .limit(1);
      return row ? toPublication(row) : null;
    },

    async listVersions(orgId, publicationId) {
      const rows = await db
        .select()
        .from(publicationVersions)
        .where(and(eq(publicationVersions.orgId, orgId), eq(publicationVersions.publicationId, publicationId)))
        .orderBy(asc(publicationVersions.versionNumber));
      return rows.map(toVersion);
    },

    async findVersionById(orgId, versionId) {
      const [row] = await db
        .select()
        .from(publicationVersions)
        .where(and(eq(publicationVersions.orgId, orgId), eq(publicationVersions.id, versionId)))
        .limit(1);
      return row ? toVersion(row) : null;
    },

    async listDistributionReferences(orgId, publicationId) {
      const rows = await db
        .select()
        .from(distributionReferences)
        .where(
          and(eq(distributionReferences.orgId, orgId), eq(distributionReferences.publicationId, publicationId)),
        )
        .orderBy(asc(distributionReferences.createdAt));
      return rows.map(toDistributionReference);
    },

    /**
     * D2.4-1 (reused): the mutation and its audit record run on the SAME
     * transaction connection — a crash before COMMIT rolls back both, and
     * the mutation cannot commit without its audit row. The audit INSERT is
     * delegated to the injected admin-audit writer (structural type), which
     * executes on `tx` and never commits.
     */
    runInTransaction: async <T>(work: (tx: PublishingTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: PublishingTransaction = {
          findPublicationById: (orgId, publicationId) => mutations.findPublicationById(orgId, publicationId),
          insertPublication: (input) => mutations.insertPublication(input),
          updatePublication: (publicationId, patch) => mutations.updatePublication(publicationId, patch),
          insertVersion: (input) => mutations.insertVersion(input),
          insertDistributionReference: (input) => mutations.insertDistributionReference(input),
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};

/** Classified-error helper shared by the service (kept near the adapter). */
export const publishingError = <R>(
  reason: import("./types").PublishingCommandErrorReason,
  message: string,
): import("./types").PublishingCommandResult<R> => ({ ok: false as const, error: { reason, message } });
