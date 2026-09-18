/**
 * Durable QC-state adapter over @stratifit/database (Drizzle).
 *
 * Owns the QC table family (SVC section 11 context 10): qc_checks,
 * qc_reviews, qc_review_decisions, qc_results, qc_issues. All access is
 * parameterized and org-scoped by the service; this adapter executes exactly
 * the statements it is given.
 *
 * D2.4-1 (reused from Stage 2.4): `runInTransaction` exposes the SAME
 * transaction connection to the domain mutations and the injected
 * `auditWriter`, so an actor-originated mutation and its audit record commit
 * atomically. The writer is a structural type satisfied by
 * `createAdminAuditService(...).transactionWriter()` — admin-audit never
 * opens a second connection.
 *
 * Immutability is enforced by the PRIVILEGE layer (0022 grants the immutable
 * families INSERT+SELECT only); this adapter declares no update/delete
 * repository paths for qc_review_decisions or qc_results at all.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  createDatabase,
  qcChecks,
  qcIssues,
  qcResults,
  qcReviewDecisions,
  qcReviews,
  type Database,
} from "@stratifit/database";
import type {
  QcAuditAppend,
  QcCheckRecord,
  QcCheckStatus,
  QcCheckType,
  QcCommandResult,
  QcDecision,
  QcEvaluatedBy,
  QcIssueRecord,
  QcIssueResolution,
  QcOutcome,
  QcRepository,
  QcResultRecord,
  QcReviewDecisionRecord,
  QcReviewRecord,
  QcReviewStatus,
  QcSeverity,
  QcSubjectKind,
  QcTransaction,
} from "./types";

export interface DrizzleQcRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /**
   * D2.4-1 (required): the admin-audit transaction writer (structural type;
   * composition roots pass `createAdminAuditService(...).transactionWriter()`).
   */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<QcAuditAppend>[0]): Promise<void> };
}

const toCheck = (row: typeof qcChecks.$inferSelect): QcCheckRecord => ({
  id: row.id,
  orgId: row.orgId,
  name: row.name,
  appliesToKind: row.appliesToKind as QcSubjectKind,
  checkType: row.checkType as QcCheckType,
  parameters: row.parameters,
  required: row.required,
  status: row.status as QcCheckStatus,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toReview = (row: typeof qcReviews.$inferSelect): QcReviewRecord => ({
  id: row.id,
  orgId: row.orgId,
  subjectKind: row.subjectKind as QcSubjectKind,
  subjectRef: row.subjectRef,
  status: row.status as QcReviewStatus,
  requestedBy: row.requestedBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toDecision = (row: typeof qcReviewDecisions.$inferSelect): QcReviewDecisionRecord => ({
  id: row.id,
  orgId: row.orgId,
  reviewId: row.reviewId,
  decision: row.decision as QcDecision,
  reviewerOperatorId: row.reviewerOperatorId,
  reason: row.reason,
  capabilityUsed: row.capabilityUsed,
  createdAt: row.createdAt.toISOString(),
});

const toResult = (row: typeof qcResults.$inferSelect): QcResultRecord => ({
  id: row.id,
  orgId: row.orgId,
  reviewId: row.reviewId,
  checkId: row.checkId,
  outcome: row.outcome as QcOutcome,
  evaluatedBy: row.evaluatedBy as QcEvaluatedBy,
  ruleRef: row.ruleRef,
  details: row.details,
  evaluatedAt: row.evaluatedAt.toISOString(),
});

const toIssue = (row: typeof qcIssues.$inferSelect): QcIssueRecord => ({
  id: row.id,
  orgId: row.orgId,
  resultId: row.resultId,
  severity: row.severity as QcSeverity,
  description: row.description,
  resolution: row.resolution as QcIssueResolution,
  resolvedBy: row.resolvedBy,
  resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** The mutating operations parameterized by executor (root OR transaction). */
const mutationsFor = (exec: Database) => ({
  insertCheck: async (input: Parameters<QcTransaction["insertCheck"]>[0]): Promise<QcCheckRecord> => {
    const [row] = await exec
      .insert(qcChecks)
      .values({
        orgId: input.orgId,
        name: input.name,
        appliesToKind: input.appliesToKind,
        checkType: input.checkType,
        parameters: input.parameters,
        required: input.required,
      })
      .returning();
    if (!row) throw new Error("qc check insert returned no row");
    return toCheck(row);
  },
  updateCheck: async (
    checkId: string,
    patch: Parameters<QcTransaction["updateCheck"]>[1],
  ): Promise<QcCheckRecord> => {
    // ONLY the approved mutable columns are ever written: parameters,
    // required, status. Name/appliesToKind/checkType are identity facts.
    const [row] = await exec
      .update(qcChecks)
      .set({
        ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {}),
        ...(patch.required !== undefined ? { required: patch.required } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(qcChecks.id, checkId))
      .returning();
    if (!row) throw new Error("qc check update returned no row");
    return toCheck(row);
  },
  insertReview: async (input: Parameters<QcTransaction["insertReview"]>[0]): Promise<QcReviewRecord> => {
    const [row] = await exec
      .insert(qcReviews)
      .values({
        orgId: input.orgId,
        subjectKind: input.subjectKind,
        subjectRef: input.subjectRef,
        requestedBy: input.requestedBy,
      })
      .returning();
    if (!row) throw new Error("qc review insert returned no row");
    return toReview(row);
  },
  updateReviewStatus: async (reviewId: string, status: QcReviewStatus): Promise<QcReviewRecord> => {
    const [row] = await exec
      .update(qcReviews)
      .set({ status, updatedAt: new Date() })
      .where(eq(qcReviews.id, reviewId))
      .returning();
    if (!row) throw new Error("qc review status update returned no row");
    return toReview(row);
  },
  insertDecision: async (
    input: Parameters<QcTransaction["insertDecision"]>[0],
  ): Promise<QcReviewDecisionRecord> => {
    const [row] = await exec
      .insert(qcReviewDecisions)
      .values({
        orgId: input.orgId,
        reviewId: input.reviewId,
        decision: input.decision,
        reviewerOperatorId: input.reviewerOperatorId,
        reason: input.reason,
        capabilityUsed: input.capabilityUsed,
      })
      .returning();
    if (!row) throw new Error("qc decision insert returned no row");
    return toDecision(row);
  },
  insertResult: async (input: Parameters<QcTransaction["insertResult"]>[0]): Promise<QcResultRecord> => {
    const [row] = await exec
      .insert(qcResults)
      .values({
        orgId: input.orgId,
        reviewId: input.reviewId,
        checkId: input.checkId,
        outcome: input.outcome,
        evaluatedBy: input.evaluatedBy,
        ruleRef: input.ruleRef,
        details: input.details,
      })
      .returning();
    if (!row) throw new Error("qc result insert returned no row");
    return toResult(row);
  },
  resolveIssue: async (
    issueId: string,
    input: Parameters<QcTransaction["resolveIssue"]>[1],
  ): Promise<QcIssueRecord> => {
    const [row] = await exec
      .update(qcIssues)
      .set({
        resolution: input.resolution,
        resolvedBy: input.resolvedBy,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(qcIssues.id, issueId))
      .returning();
    if (!row) throw new Error("qc issue resolution returned no row");
    return toIssue(row);
  },
});

export const createQcRepository = (deps: DrizzleQcRepositoryDeps): QcRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db);

  return {
    async findCheckById(orgId, checkId) {
      const [row] = await db
        .select()
        .from(qcChecks)
        .where(and(eq(qcChecks.orgId, orgId), eq(qcChecks.id, checkId)))
        .limit(1);
      return row ? toCheck(row) : null;
    },

    async findCheckByName(orgId, name) {
      const [row] = await db
        .select()
        .from(qcChecks)
        .where(and(eq(qcChecks.orgId, orgId), eq(qcChecks.name, name)))
        .limit(1);
      return row ? toCheck(row) : null;
    },

    async listChecksByOrg(orgId, filter) {
      const conditions = [eq(qcChecks.orgId, orgId)];
      if (filter?.appliesToKind !== undefined) conditions.push(eq(qcChecks.appliesToKind, filter.appliesToKind));
      if (filter?.status !== undefined) conditions.push(eq(qcChecks.status, filter.status));
      const rows = await db
        .select()
        .from(qcChecks)
        .where(and(...conditions))
        .orderBy(asc(qcChecks.name));
      return rows.map(toCheck);
    },

    async findReviewById(id) {
      const [row] = await db.select().from(qcReviews).where(eq(qcReviews.id, id)).limit(1);
      return row ? toReview(row) : null;
    },

    async findReviewBySubject(orgId, subjectKind, subjectRef) {
      const [row] = await db
        .select()
        .from(qcReviews)
        .where(
          and(
            eq(qcReviews.orgId, orgId),
            eq(qcReviews.subjectKind, subjectKind),
            eq(qcReviews.subjectRef, subjectRef),
          ),
        )
        .limit(1);
      return row ? toReview(row) : null;
    },

    async listReviewsByOrg(orgId, filter) {
      const conditions = [eq(qcReviews.orgId, orgId)];
      if (filter?.status !== undefined) conditions.push(eq(qcReviews.status, filter.status));
      if (filter?.subjectKind !== undefined) conditions.push(eq(qcReviews.subjectKind, filter.subjectKind));
      const rows = await db
        .select()
        .from(qcReviews)
        .where(and(...conditions))
        .orderBy(desc(qcReviews.createdAt));
      return rows.map(toReview);
    },

    async findDecisionById(id) {
      const [row] = await db.select().from(qcReviewDecisions).where(eq(qcReviewDecisions.id, id)).limit(1);
      return row ? toDecision(row) : null;
    },

    async listDecisionsByReviewId(reviewId) {
      const rows = await db
        .select()
        .from(qcReviewDecisions)
        .where(eq(qcReviewDecisions.reviewId, reviewId))
        .orderBy(asc(qcReviewDecisions.createdAt));
      return rows.map(toDecision);
    },

    async listResultsByReviewId(reviewId) {
      const rows = await db
        .select()
        .from(qcResults)
        .where(eq(qcResults.reviewId, reviewId))
        .orderBy(desc(qcResults.evaluatedAt), desc(qcResults.id));
      return rows.map(toResult);
    },

    async findIssueById(id) {
      const [row] = await db.select().from(qcIssues).where(eq(qcIssues.id, id)).limit(1);
      return row ? toIssue(row) : null;
    },

    async listIssuesByResultIds(resultIds) {
      if (resultIds.length === 0) return [];
      const rows = await db
        .select()
        .from(qcIssues)
        .where(inArray(qcIssues.resultId, [...resultIds]))
        .orderBy(asc(qcIssues.createdAt));
      return rows.map(toIssue);
    },

    insertCheck: (input) => direct.insertCheck(input),
    updateCheck: (checkId, patch) => direct.updateCheck(checkId, patch),
    insertReview: (input) => direct.insertReview(input),
    updateReviewStatus: (reviewId, status) => direct.updateReviewStatus(reviewId, status),
    insertDecision: (input) => direct.insertDecision(input),
    insertResult: (input) => direct.insertResult(input),
    resolveIssue: (issueId, input) => direct.resolveIssue(issueId, input),

    /**
     * D2.4-1 (reused): the mutation and its audit record run on the SAME
     * transaction connection — a crash before COMMIT rolls back both, and
     * the mutation cannot commit without its audit row. The audit INSERT is
     * delegated to the injected admin-audit writer (structural type), which
     * executes on `tx` and never commits.
     */
    runInTransaction: async <T>(work: (tx: QcTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: QcTransaction = {
          insertCheck: (input) => mutations.insertCheck(input),
          updateCheck: (checkId, patch) => mutations.updateCheck(checkId, patch),
          insertReview: (input) => mutations.insertReview(input),
          updateReviewStatus: (reviewId, status) => mutations.updateReviewStatus(reviewId, status),
          insertDecision: (input) => mutations.insertDecision(input),
          insertResult: (input) => mutations.insertResult(input),
          resolveIssue: (issueId, input) => mutations.resolveIssue(issueId, input),
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};

/** Classified-error helper shared by the service (kept near the adapter). */
export const qcError = <R>(
  reason: import("./types").QcCommandErrorReason,
  message: string,
): QcCommandResult<R> => ({ ok: false as const, error: { reason, message } });
