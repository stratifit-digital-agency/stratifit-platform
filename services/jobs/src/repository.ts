/**
 * Durable job-state adapter over @stratifit/database (Drizzle).
 *
 * Owns the job table family (SVC section 11 context 9): jobs,
 * job_dependencies, job_attempts, compute_requirements, compute_usage. All
 * access is parameterized and org-scoped by the service; this adapter
 * executes exactly the statements it is given.
 *
 * D2.4-1 (reused from Stage 2.4): `runInTransaction` exposes the SAME
 * transaction connection to the domain mutations and the injected
 * `auditWriter`, so a security-critical mutation and its audit record commit
 * atomically. The writer is a structural type satisfied by
 * `createAdminAuditService(...).transactionWriter()` — admin-audit never
 * opens a second connection.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  computeRequirements,
  computeUsage,
  createDatabase,
  jobAttempts,
  jobDependencies,
  jobs,
  type Database,
} from "@stratifit/database";
import type {
  ComputeRequirementRecord,
  ComputeUsageRecord,
  JobAttemptOutcome,
  JobAttemptRecord,
  JobAuditAppend,
  JobRecord,
  JobsRepository,
  JobsTransaction,
  JobStatus,
  JobType,
} from "./types";

export interface DrizzleJobsRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /**
   * D2.4-1 (required): the admin-audit transaction writer (structural type;
   * composition roots pass `createAdminAuditService(...).transactionWriter()`).
   */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<JobAuditAppend>[0]): Promise<void> };
}

const toJob = (row: typeof jobs.$inferSelect): JobRecord => ({
  id: row.id,
  orgId: row.orgId,
  jobType: row.jobType as JobType,
  idempotencyKey: row.idempotencyKey,
  subjectKind: row.subjectKind,
  subjectId: row.subjectId,
  manifestRef: row.manifestRef,
  computeRequirementId: row.computeRequirementId,
  status: row.status as JobStatus,
  priority: row.priority,
  maxAttempts: row.maxAttempts,
  attemptCount: row.attemptCount,
  progress: row.progress,
  lastError: row.lastError,
  cancellationRequested: row.cancellationRequested,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toAttempt = (row: typeof jobAttempts.$inferSelect): JobAttemptRecord => ({
  id: row.id,
  orgId: row.orgId,
  jobId: row.jobId,
  attemptNumber: row.attemptNumber,
  workerRef: row.workerRef,
  allocationRef: row.allocationRef,
  startedAt: row.startedAt.toISOString(),
  completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  outcome: (row.outcome as JobAttemptOutcome | null) ?? null,
  errorDetail: row.errorDetail,
  progressSnapshot: row.progressSnapshot,
  usageRecordId: row.usageRecordId,
});

const toRequirement = (row: typeof computeRequirements.$inferSelect): ComputeRequirementRecord => ({
  id: row.id,
  orgId: row.orgId,
  gpuClass: row.gpuClass,
  vramGb: row.vramGb,
  workers: row.workers,
  concurrency: row.concurrency,
  estimatedRuntimeSeconds: row.estimatedRuntimeSeconds,
  storageMb: row.storageMb,
  estimatedCostUsd: row.estimatedCostUsd,
  createdAt: row.createdAt.toISOString(),
});

const toUsage = (row: typeof computeUsage.$inferSelect): ComputeUsageRecord => ({
  id: row.id,
  orgId: row.orgId,
  allocationRef: row.allocationRef,
  actualRuntimeSeconds: row.actualRuntimeSeconds,
  actualCostUsd: row.actualCostUsd,
  recordedAt: row.recordedAt.toISOString(),
});

/** The six mutating operations parameterized by executor (root OR transaction). */
const mutationsFor = (exec: Database) => {
  /**
   * The Option-B definer functions are org-scoped; the port shape passes
   * only the attempt id, so the org is resolved first (SELECT is granted to
   * runtime) and handed to the function on the SAME connection.
   */
  const attemptOrgId = async (attemptId: string): Promise<string> => {
    const [row] = await exec
      .select({ orgId: jobAttempts.orgId })
      .from(jobAttempts)
      .where(eq(jobAttempts.id, attemptId))
      .limit(1);
    if (!row) throw new Error("job attempt not found");
    return row.orgId;
  };

  /**
   * Verification seam exposing the definer functions' org parameter
   * (concrete-only; used by live tests to prove the org/attempt consistency
   * guard — NOT an independent database tenant-authorization boundary;
   * organization authorization is enforced by the trusted service layer). The
   * definer call executes on THIS connection — transaction scope preserved.
   */
  const completeJobAttemptScoped = async (
    orgId: string,
    attemptId: string,
    patch: {
      outcome: JobAttemptOutcome;
      errorDetail: string | null;
      progressSnapshot: Record<string, unknown>;
      usageRecordId: string | null;
    },
  ): Promise<JobAttemptRecord> => {
    await exec.execute(
      sql`select public.close_job_attempt(${orgId}::uuid, ${attemptId}::uuid, ${patch.outcome}::text, ${patch.errorDetail}::text, ${JSON.stringify(patch.progressSnapshot ?? {})}::jsonb, ${patch.usageRecordId}::uuid)`,
    );
    const [row] = await exec
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.id, attemptId))
      .limit(1);
    if (!row) throw new Error("job attempt completion returned no row");
    return toAttempt(row);
  };
  /** Verification seam for the progress definer function's org parameter. */
  const recordJobAttemptProgressScoped = async (
    orgId: string,
    attemptId: string,
    progressSnapshot: Record<string, unknown>,
  ): Promise<void> => {
    await exec.execute(
      sql`select public.record_job_attempt_progress(${orgId}::uuid, ${attemptId}::uuid, ${JSON.stringify(progressSnapshot ?? {})}::jsonb)`,
    );
  };

  return {
  insertJob: async (input: {
    orgId: string;
    jobType: JobType;
    idempotencyKey: string;
    subjectKind: string;
    subjectId: string;
    manifestRef: string | null;
    computeRequirementId: string | null;
    priority: number;
    maxAttempts: number;
  }): Promise<JobRecord> => {
    const [row] = await exec
      .insert(jobs)
      .values({
        orgId: input.orgId,
        jobType: input.jobType,
        idempotencyKey: input.idempotencyKey,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        manifestRef: input.manifestRef,
        computeRequirementId: input.computeRequirementId,
        priority: input.priority,
        maxAttempts: input.maxAttempts,
      })
      .returning();
    if (!row) throw new Error("job insert returned no row");
    return toJob(row);
  },
  updateJob: async (
    jobId: string,
    patch: {
      status?: JobStatus;
      attemptCount?: number;
      progress?: number;
      lastError?: string | null;
      cancellationRequested?: boolean;
    },
  ): Promise<JobRecord> => {
    const [row] = await exec
      .update(jobs)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.attemptCount !== undefined ? { attemptCount: patch.attemptCount } : {}),
        ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.cancellationRequested !== undefined
          ? { cancellationRequested: patch.cancellationRequested }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId))
      .returning();
    if (!row) throw new Error("job update returned no row");
    return toJob(row);
  },
  insertJobDependency: async (input: { orgId: string; jobId: string; dependsOnJobId: string }): Promise<void> => {
    await exec.insert(jobDependencies).values({
      orgId: input.orgId,
      jobId: input.jobId,
      dependsOnJobId: input.dependsOnJobId,
    });
  },
  insertJobAttempt: async (input: {
    orgId: string;
    jobId: string;
    attemptNumber: number;
    workerRef: string;
    allocationRef: string | null;
  }): Promise<JobAttemptRecord> => {
    const [row] = await exec
      .insert(jobAttempts)
      .values({
        orgId: input.orgId,
        jobId: input.jobId,
        attemptNumber: input.attemptNumber,
        workerRef: input.workerRef,
        allocationRef: input.allocationRef,
      })
      .returning();
    if (!row) throw new Error("job attempt insert returned no row");
    return toAttempt(row);
  },
  completeJobAttempt: async (
    attemptId: string,
    patch: {
      outcome: JobAttemptOutcome;
      errorDetail: string | null;
      progressSnapshot: Record<string, unknown>;
      usageRecordId: string | null;
    },
  ): Promise<JobAttemptRecord> => {
    // Approved Option B (Stage 2.7 blocker resolution): job_attempts stays
    // INSERT+SELECT ONLY for stratifit_runtime — the terminal transition is
    // performed by the hardened SECURITY DEFINER function
    // public.close_job_attempt (one-shot: only an OPEN attempt can close;
    // static SQL; search_path = ''; migrator-owned; org-scoped). The call
    // executes on THIS connection, so the D2.4-1 transaction scope is
    // preserved and the function raises if the attempt is not open.
    const orgId = await attemptOrgId(attemptId);
    return completeJobAttemptScoped(orgId, attemptId, patch);
  },
  /** Verification seam for the definer functions' org parameter (live tests). */
  completeJobAttemptScoped,
  recordJobAttemptProgress: async (
    attemptId: string,
    progressSnapshot: Record<string, unknown>,
  ): Promise<void> => {
    // Same Option-B channel: progress snapshots go through
    // public.record_job_attempt_progress (open attempts only, org-scoped).
    const orgId = await attemptOrgId(attemptId);
    await recordJobAttemptProgressScoped(orgId, attemptId, progressSnapshot);
  },
  /** Verification seam for the progress definer function's org parameter. */
  recordJobAttemptProgressScoped,
  insertComputeUsage: async (input: {
    orgId: string;
    allocationRef: string;
    actualRuntimeSeconds: number;
    actualCostUsd: string;
  }): Promise<ComputeUsageRecord> => {
    const [row] = await exec
      .insert(computeUsage)
      .values({
        orgId: input.orgId,
        allocationRef: input.allocationRef,
        actualRuntimeSeconds: input.actualRuntimeSeconds,
        actualCostUsd: input.actualCostUsd,
      })
      .returning();
    if (!row) throw new Error("compute usage insert returned no row");
    return toUsage(row);
  },
  };
};

/**
 * Concrete Drizzle repository = the durable port PLUS the verification seams
 * that expose the definer functions' org parameter (live tests use them to
 * prove the org/attempt consistency guard (tenant authorization itself is
 * service-level, not independently enforced by PostgreSQL); production code
 * uses the port methods,
 * which resolve the org internally).
 */
export type DrizzleJobsRepository = JobsRepository & {
  completeJobAttemptScoped(
    orgId: string,
    attemptId: string,
    patch: {
      outcome: JobAttemptOutcome;
      errorDetail: string | null;
      progressSnapshot: Record<string, unknown>;
      usageRecordId: string | null;
    },
  ): Promise<JobAttemptRecord>;
  recordJobAttemptProgressScoped(orgId: string, attemptId: string, progressSnapshot: Record<string, unknown>): Promise<void>;
};

export const createDrizzleJobsRepository = (
  deps: DrizzleJobsRepositoryDeps,
): DrizzleJobsRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db);

  return {
    async findJobById(id) {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return row ? toJob(row) : null;
    },

    async findJobByIdempotencyKey(orgId, jobType, idempotencyKey) {
      const [row] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.orgId, orgId), eq(jobs.jobType, jobType), eq(jobs.idempotencyKey, idempotencyKey)))
        .limit(1);
      return row ? toJob(row) : null;
    },

    async listJobsByOrg(orgId, filter) {
      const conditions = [eq(jobs.orgId, orgId)];
      if (filter?.status !== undefined) conditions.push(eq(jobs.status, filter.status));
      if (filter?.subjectKind !== undefined) conditions.push(eq(jobs.subjectKind, filter.subjectKind));
      if (filter?.subjectId !== undefined) conditions.push(eq(jobs.subjectId, filter.subjectId));
      const rows = await db
        .select()
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt));
      return rows.map(toJob);
    },

    async listJobDependencies(jobId) {
      const rows = await db
        .select({ jobId: jobDependencies.jobId, dependsOnJobId: jobDependencies.dependsOnJobId })
        .from(jobDependencies)
        .where(eq(jobDependencies.jobId, jobId))
        .orderBy(asc(jobDependencies.dependsOnJobId));
      return rows;
    },

    async listDependentJobIds(jobId) {
      const rows = await db
        .select({ jobId: jobDependencies.jobId })
        .from(jobDependencies)
        .where(eq(jobDependencies.dependsOnJobId, jobId));
      return rows.map((r) => r.jobId);
    },

    async listUnresolvedDependencies(jobId) {
      // Dependencies not yet in a terminal state gate execution (DM section
      // 32.1: B starts after A reaches a terminal state).
      const depRows = await db
        .select({ dependsOnJobId: jobDependencies.dependsOnJobId })
        .from(jobDependencies)
        .where(eq(jobDependencies.jobId, jobId));
      if (depRows.length === 0) return [];
      const ids = depRows.map((r) => r.dependsOnJobId);
      const rows = await db
        .select()
        .from(jobs)
        .where(and(inArray(jobs.id, ids), inArray(jobs.status, ["created", "queued", "running"])));
      return rows.map(toJob);
    },

    async findJobAttemptById(id) {
      const [row] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, id)).limit(1);
      return row ? toAttempt(row) : null;
    },

    async findLatestAttempt(jobId) {
      const [row] = await db
        .select()
        .from(jobAttempts)
        .where(eq(jobAttempts.jobId, jobId))
        .orderBy(desc(jobAttempts.attemptNumber))
        .limit(1);
      return row ? toAttempt(row) : null;
    },

    async listAttemptsByJob(jobId) {
      const rows = await db
        .select()
        .from(jobAttempts)
        .where(eq(jobAttempts.jobId, jobId))
        .orderBy(desc(jobAttempts.attemptNumber));
      return rows.map(toAttempt);
    },

    async findComputeRequirementById(id) {
      const [row] = await db
        .select()
        .from(computeRequirements)
        .where(eq(computeRequirements.id, id))
        .limit(1);
      return row ? toRequirement(row) : null;
    },

    // Direct (non-transactional) mutations — the TEST-ONLY sequential
    // fallback path mirrors MembershipRepository; the service prefers
    // runInTransaction whenever it exists.
    insertJob: (input) => direct.insertJob(input),
    updateJob: (jobId, patch) => direct.updateJob(jobId, patch),
    insertJobDependency: (input) => direct.insertJobDependency(input),
    insertJobAttempt: (input) => direct.insertJobAttempt(input),
    completeJobAttempt: (attemptId, patch) => direct.completeJobAttempt(attemptId, patch),
    recordJobAttemptProgress: (attemptId, progressSnapshot) => direct.recordJobAttemptProgress(attemptId, progressSnapshot),
    completeJobAttemptScoped: (orgId, attemptId, patch) => direct.completeJobAttemptScoped(orgId, attemptId, patch),
    recordJobAttemptProgressScoped: (orgId, attemptId, progressSnapshot) => direct.recordJobAttemptProgressScoped(orgId, attemptId, progressSnapshot),
    insertComputeUsage: (input) => direct.insertComputeUsage(input),

    /**
     * D2.4-1 (reused): the mutation and its audit record run on the SAME
     * transaction connection — a crash before COMMIT rolls back both, and
     * the mutation cannot commit without its audit row. The audit INSERT is
     * delegated to the injected admin-audit writer (structural type), which
     * executes on `tx` and never commits.
     */
    runInTransaction: async <T>(work: (tx: JobsTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: JobsTransaction = {
          insertJob: (input) => mutations.insertJob(input),
          updateJob: (jobId, patch) => mutations.updateJob(jobId, patch),
          insertJobDependency: (input) => mutations.insertJobDependency(input),
          insertJobAttempt: (input) => mutations.insertJobAttempt(input),
          completeJobAttempt: (attemptId, patch) => mutations.completeJobAttempt(attemptId, patch),
          recordJobAttemptProgress: (attemptId, progressSnapshot) => mutations.recordJobAttemptProgress(attemptId, progressSnapshot),
          insertComputeUsage: (input) => mutations.insertComputeUsage(input),
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};
