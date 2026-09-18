/**
 * Job domain service (Stage 2.7, decisions D2.7-1..D2.7-5).
 *
 * Operator-originated commands enforce, in order: capability ->
 * org boundary -> state-machine validity -> invariant checks -> persistence
 * -> post-commit event publication (Stage-1 semantics, existing job.* names
 * only). Worker-path attempt commands (startAttempt, recordProgress,
 * completeAttempt, failAttempt) carry the WorkerContext and are NOT
 * operator-audited in Stage 2.7 (approved audit matrix).
 *
 * D2.4-1 (reused): actor-originated security-sensitive mutations (enqueueJob
 * with an actor, cancelJob) and their audit records commit inside the SAME
 * database transaction via `JobsRepository.runInTransaction` — a crash
 * before COMMIT rolls back BOTH, and a successful mutation cannot commit
 * without its audit record. Repositories without transaction support fail
 * closed unless the TEST-ONLY `allowSequentialAudit` flag is set; production
 * composition roots never set it.
 *
 * D2.7-1: there is NO automatic production.approved -> jobs.enqueue wiring
 * — producers call enqueueJob explicitly. D2.7-4: no claim/lease/heartbeat
 * API — attempts are recorded through this service only. D2.7-5: PostgreSQL
 * job state is authoritative; events are post-commit announcements (a failed
 * transaction never publishes a successful event).
 */
import { randomUUID } from "node:crypto";
import type { ControlCapability } from "@stratifit/permissions";
import { emitEvent, InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  JobActor,
  JobAuditAppend,
  JobAttemptOutcome,
  JobAttemptRecord,
  JobCommandError,
  JobCommandErrorReason,
  JobCommandResult,
  JobRecord,
  JobsRepository,
  JobsTransaction,
  JobStatus,
  JobType,
  WorkerContext,
} from "./types";
import { JOB_TRANSITIONS, TERMINAL_JOB_STATUSES } from "./types";

export interface JobsServiceDeps {
  repository: JobsRepository;
  /** Defaults to an in-process publisher with no handlers (Stage-1 semantics). */
  publisher?: EventPublisher;
  /** Fallback audit seam (used only when the repository has no transaction support). */
  auditAppend?: JobAuditAppend;
  /**
   * TEST-ONLY: permit the sequential (non-transactional) audit fallback for
   * repositories without `runInTransaction`. Production composition roots
   * never set it — there the service fail-closes instead (D2.4-1).
   */
  allowSequentialAudit?: boolean;
  eventIdFactory?: () => string;
}

export interface EnqueueOutcome {
  readonly job: JobRecord;
  /** True when the enqueue resolved to the EXISTING job (idempotent dedupe). */
  readonly deduplicated: boolean;
}

export interface JobsService {
  // ---- operator-originated (capability-gated, audited where actor exists) ----
  enqueueJob(
    actor: JobActor | null,
    input: {
      jobType: JobType;
      idempotencyKey: string;
      subjectKind: string;
      subjectId: string;
      manifestRef?: string | null;
      computeRequirementId?: string | null;
      priority?: number;
      maxAttempts?: number;
      dependsOnJobIds?: readonly string[];
    },
  ): Promise<JobCommandResult<EnqueueOutcome>>;
  cancelJob(actor: JobActor, jobId: string): Promise<JobCommandResult<JobRecord>>;
  retryJob(actor: JobActor, jobId: string): Promise<JobCommandResult<JobRecord>>;

  // ---- worker-path attempt recording (NOT operator-audited in 2.7) ----
  startAttempt(worker: WorkerContext, jobId: string): Promise<JobCommandResult<{ job: JobRecord; attempt: JobAttemptRecord }>>;
  recordProgress(worker: WorkerContext, jobId: string, progress: number, snapshot?: Record<string, unknown>): Promise<JobCommandResult<JobRecord>>;
  completeAttempt(worker: WorkerContext, jobId: string, input: { progress?: number; usageRecordId?: string | null }): Promise<JobCommandResult<{ job: JobRecord; attempt: JobAttemptRecord }>>;
  failAttempt(worker: WorkerContext, jobId: string, input: { errorDetail: string; outcome?: "failed" | "timed_out" }): Promise<JobCommandResult<{ job: JobRecord; attempt: JobAttemptRecord }>>;

  // ---- compute accounting (records only; no provider activation) ----
  recordComputeUsage(actor: JobActor | null, input: { allocationRef: string; actualRuntimeSeconds: number; actualCostUsd: string }): Promise<JobCommandResult<import("./types").ComputeUsageRecord>>;

  // ---- org-scoped queries ----
  getJob(actor: JobActor, jobId: string): Promise<JobCommandResult<JobRecord>>;
  listJobs(actor: JobActor, filter?: { status?: JobStatus; subjectKind?: string; subjectId?: string }): Promise<JobRecord[]>;
  listAttempts(actor: JobActor, jobId: string): Promise<JobCommandResult<JobAttemptRecord[]>>;
}

const JOB_CAPABILITY: ControlCapability = "admin.permissions";

export const createJobsService = (deps: JobsServiceDeps): JobsService => {
  const repo = deps.repository;
  const publisher = deps.publisher ?? new InProcessEventPublisher();
  const fallbackAudit = deps.auditAppend ?? (async () => {});
  const nextEventId = deps.eventIdFactory ?? (() => randomUUID());

  const err = (reason: JobCommandErrorReason, message: string) => ({
    ok: false as const,
    error: { reason, message },
  });

  const requireCapability = (actor: JobActor) =>
    actor.capabilities.includes(JOB_CAPABILITY)
      ? null
      : err("missing_capability", `${JOB_CAPABILITY} capability required`);

  const auditEntry = (
    actor: JobActor,
    action: string,
    targetId: string,
    metadata?: Record<string, unknown>,
  ): Parameters<JobAuditAppend>[0] => ({
    actorId: actor.operatorId,
    action,
    targetType: "job",
    targetId,
    // D2.4-2: the acting operator's org scopes the audit record.
    organizationId: actor.organizationId,
    ...(metadata === undefined ? {} : { metadata }),
    correlationId: actor.correlationId ?? null,
    causationId: null,
  });

  /**
   * D2.4-1 dispatch (reused from the membership/production services): run
   * the mutation and its audit append inside ONE database transaction when
   * the repository supports it; otherwise fail closed unless the test-only
   * fallback flag is set. When `actor` is null the command is system-
   * originated (no operator to audit) and runs without an audit append.
   */
  const persistAndAudit = async <T>(
    actor: JobActor | null,
    action: string,
    describe: (value: T) => { targetId: string; metadata?: Record<string, unknown> },
    run: (tx: JobsTransaction) => Promise<T>,
  ): Promise<T> => {
    if (actor === null) {
      // System-originated: no operator audit record (nothing security-
      // sensitive to attribute); plain transactional (or direct) path.
      if (repo.runInTransaction) return repo.runInTransaction(run);
      return run(directTx());
    }
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
          "job mutations cannot commit without a same-transaction audit " +
          "record. (The sequential audit fallback is test-only and must be " +
          "enabled explicitly via allowSequentialAudit.)",
      );
    }
    const value = await run(directTx());
    const { targetId, metadata } = describe(value);
    await fallbackAudit(auditEntry(actor, action, targetId, metadata));
    return value;
  };

  const directTx = (): JobsTransaction => ({
    insertJob: (input) => repo.insertJob(input),
    updateJob: (jobId, patch) => repo.updateJob(jobId, patch),
    insertJobDependency: (input) => repo.insertJobDependency(input),
    insertJobAttempt: (input) => repo.insertJobAttempt(input),
    completeJobAttempt: (attemptId, patch) => repo.completeJobAttempt(attemptId, patch),
    recordJobAttemptProgress: (attemptId, progressSnapshot) => repo.recordJobAttemptProgress(attemptId, progressSnapshot),
    insertComputeUsage: (input) => repo.insertComputeUsage(input),
    appendAudit: (entry) => fallbackAudit(entry),
  });

  const emit = async (
    name: "job.created" | "job.started" | "job.progress" | "job.completed" | "job.failed" | "job.cancelled",
    payload: Record<string, unknown>,
    correlation: { organizationId: string; jobId: string },
  ) => {
    await emitEvent(publisher, {
      eventId: nextEventId(),
      name,
      correlation,
      payload,
    });
  };

  /** Terminal-state check for dependencies (DM section 32.1: B after A terminal). */
  const isTerminal = (status: JobStatus) => TERMINAL_JOB_STATUSES.includes(status);

  /**
   * Cycle detection (DFS over dependency edges) BEFORE insert — a cycle
   * would deadlock the DAG permanently, so enqueue fails closed. Edges are
   * only ever added from a brand-new job into the existing graph, so a cycle
   * would require a pre-existing cycle among reachable jobs; the walk fails
   * fast on one as defense in depth (e.g. if a later stage ever adds an
   * edge-mutation command).
   */
  const assertNoCycle = async (dependencyIds: readonly string[]): Promise<JobCommandError | null> => {
    const seen = new Set<string>();
    const stack = [...dependencyIds];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const edges = await repo.listJobDependencies(current);
      for (const e of edges) {
        if (e.dependsOnJobId === current) continue;
        stack.push(e.dependsOnJobId);
      }
    }
    return null;
  };

  return {
    async enqueueJob(actor, input) {
      if (actor !== null) {
        const capFail = requireCapability(actor);
        if (capFail) return capFail;
      }
      if (!input.idempotencyKey || input.idempotencyKey.length > 512) {
        return err("invalid_request", "idempotencyKey must be a non-empty string of at most 512 characters");
      }
      if (actor === null) {
        return err("invalid_request", "enqueueJob requires an actor organization in Stage 2.7");
      }
      if (!input.subjectKind || input.subjectKind.length > 128) {
        return err("invalid_request", "subjectKind must be a non-empty string of at most 128 characters");
      }

      // Invariant 7 idempotency: same (org, type, key) resolves to the
      // EXISTING job — a duplicate enqueue is never an error and never
      // creates a second row.
      const scopeOrg = actor?.organizationId;
      const existing = await repo.findJobByIdempotencyKey(scopeOrg!, input.jobType, input.idempotencyKey);
      if (existing) {
        return { ok: true, value: { job: existing, deduplicated: true } };
      }

      // Dependency validation BEFORE insert: existence, same-org, no self,
      // no cycle (service-level; schema CHECKs back the schema-level parts).
      const dependencyIds = [...new Set(input.dependsOnJobIds ?? [])];
      if (dependencyIds.length > 0) {
        for (const depId of dependencyIds) {
          const dep = await repo.findJobById(depId);
          if (!dep) return err("dependency_not_found", `dependency ${depId} does not exist`);
          if (scopeOrg !== undefined && dep.orgId !== scopeOrg) {
            return err("dependency_cross_org", `dependency ${depId} belongs to a different organization`);
          }
        }
        // Cycle rejection over the reachable dependency graph (defense in
        // depth; see assertNoCycle — edges added here cannot create a cycle
        // through the brand-new job).
        const cycleErr = await assertNoCycle(dependencyIds);
        if (cycleErr) return { ok: false as const, error: cycleErr };
      }

      const orgId = scopeOrg!;
      const job = await persistAndAudit<JobRecord>(
        actor,
        "jobs.job_enqueued",
        (j) => ({
          targetId: j.id,
          metadata: { jobType: j.jobType, idempotencyKey: j.idempotencyKey, subjectKind: j.subjectKind, subjectId: j.subjectId },
        }),
        async (tx) => {
          const created = await tx.insertJob({
            orgId,
            jobType: input.jobType,
            idempotencyKey: input.idempotencyKey,
            subjectKind: input.subjectKind,
            subjectId: input.subjectId,
            manifestRef: input.manifestRef ?? null,
            computeRequirementId: input.computeRequirementId ?? null,
            priority: input.priority ?? 0,
            maxAttempts: input.maxAttempts ?? 3,
          });
          for (const depId of dependencyIds) {
            await tx.insertJobDependency({ orgId, jobId: created.id, dependsOnJobId: depId });
          }
          // Enqueue IS the queue insertion: created -> queued happens in the
          // same transaction (DM section 32.1 edge), so the job is visible to
          // workers only after the idempotent enqueue commits.
          return tx.updateJob(created.id, { status: "queued" });
        },
      );

      await emit("job.created", { jobId: job.id, jobType: job.jobType, subjectKind: job.subjectKind, subjectId: job.subjectId }, { organizationId: orgId, jobId: job.id });
      return { ok: true, value: { job, deduplicated: false } };
    },

    async cancelJob(actor, jobId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const job = await repo.findJobById(jobId);
      if (!job || job.orgId !== actor.organizationId) {
        return err("job_not_found", "job does not exist in your organization");
      }
      if (isTerminal(job.status)) {
        return err("invalid_transition", `job is already ${job.status}`);
      }
      // DM section 32.1: created/queued/running -> cancelled where legally
      // permitted (all three non-terminal states may cancel).
      if (!JOB_TRANSITIONS[job.status].includes("cancelled")) {
        return err("invalid_transition", `cannot cancel a ${job.status} job`);
      }
      const updated = await persistAndAudit<JobRecord>(
        actor,
        "jobs.job_cancelled",
        (j) => ({ targetId: j.id, metadata: { from: job.status, to: j.status } }),
        (tx) => tx.updateJob(job.id, { status: "cancelled" }),
      );
      await emit("job.cancelled", { jobId: updated.id, previousStatus: job.status }, { organizationId: actor.organizationId, jobId: updated.id });
      return { ok: true, value: updated };
    },

    async retryJob(actor, jobId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const job = await repo.findJobById(jobId);
      if (!job || job.orgId !== actor.organizationId) {
        return err("job_not_found", "job does not exist in your organization");
      }
      // Retry = manual failed -> queued (same idempotency key, invariant 7);
      // max attempts still bound the total attempt count.
      if (job.status !== "failed") {
        return err("invalid_transition", `only a failed job can be retried (state: ${job.status})`);
      }
      if (job.attemptCount >= job.maxAttempts) {
        return err("max_attempts_exhausted", `job exhausted its ${job.maxAttempts} attempts`);
      }
      const updated = await persistAndAudit<JobRecord>(
        actor,
        "jobs.job_retried",
        (j) => ({ targetId: j.id, metadata: { from: job.status, to: j.status, attemptCount: j.attemptCount } }),
        (tx) => tx.updateJob(job.id, { status: "queued" }),
      );
      await emit("job.progress", { jobId: updated.id, reason: "retry", status: "queued" }, { organizationId: actor.organizationId, jobId: updated.id });
      return { ok: true, value: updated };
    },

    async startAttempt(worker, jobId) {
      if (!worker.workerRef) return err("invalid_request", "workerRef is required");
      const job = await repo.findJobById(jobId);
      if (!job) return err("job_not_found", "job does not exist");
      // Execution gating: dependencies must be terminal before the job runs
      // (DM section 32.1); cancellation overlay is observed at safe points.
      const unresolved = await repo.listUnresolvedDependencies(job.id);
      if (unresolved.length > 0) {
        return err("dependency_unresolved", `job has ${unresolved.length} unresolved dependencies`);
      }
      if (job.status === "created") {
        return err("invalid_transition", "job has not been queued");
      }
      if (job.status !== "queued") {
        return err("invalid_transition", `job must be queued to start an attempt (state: ${job.status})`);
      }
      if (job.cancellationRequested) {
        const cancelled = await persistAndAudit<JobRecord>(null, "", () => ({ targetId: job.id }), (tx) =>
          tx.updateJob(job.id, { status: "cancelled" }),
        );
        await emit("job.cancelled", { jobId: cancelled.id, previousStatus: job.status }, { organizationId: job.orgId, jobId: cancelled.id });
        return err("invalid_transition", "job cancellation was requested before the attempt started");
      }
      if (job.attemptCount >= job.maxAttempts) {
        return err("max_attempts_exhausted", `job exhausted its ${job.maxAttempts} attempts`);
      }
      const nextAttempt = job.attemptCount + 1;
      const result = await persistAndAudit<{ job: JobRecord; attempt: JobAttemptRecord }>(
        null,
        "",
        (r) => ({ targetId: r.job.id }),
        async (tx) => {
          const attempt = await tx.insertJobAttempt({
            orgId: job.orgId,
            jobId: job.id,
            attemptNumber: nextAttempt,
            workerRef: worker.workerRef,
            allocationRef: worker.allocationRef ?? null,
          });
          const updated = await tx.updateJob(job.id, { status: "running", attemptCount: nextAttempt });
          return { job: updated, attempt };
        },
      );
      await emit("job.started", { jobId: result.job.id, attemptId: result.attempt.id, attemptNumber: nextAttempt, workerRef: worker.workerRef }, { organizationId: job.orgId, jobId: result.job.id });
      return { ok: true, value: result };
    },

    async recordProgress(worker, jobId, progress, snapshot) {
      void worker;
      if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
        return err("invalid_request", "progress must be an integer between 0 and 100");
      }
      const job = await repo.findJobById(jobId);
      if (!job) return err("job_not_found", "job does not exist");
      if (job.status !== "running") {
        return err("invalid_transition", `progress can only be recorded on a running job (state: ${job.status})`);
      }
      const updated = await persistAndAudit<JobRecord>(
        null,
        "",
        (j) => ({ targetId: j.id }),
        (tx) => tx.updateJob(job.id, { progress }),
      );
      if (snapshot !== undefined) {
        const latest = await repo.findLatestAttempt(job.id);
        // Attempt rows are immutable EXCEPT for the in-flight progress
        // snapshot + terminal completion (DM section 16: "progress snapshots
        // (resume support)"); completion closes the row permanently. Both
        // writes go through the hardened SECURITY DEFINER channels (Option
        // B): progress on OPEN attempts only; closing is one-shot.
        if (latest && latest.completedAt === null) {
          await repo.recordJobAttemptProgress(latest.id, snapshot);
        }
      }
      await emit("job.progress", { jobId: updated.id, progress }, { organizationId: job.orgId, jobId: updated.id });
      return { ok: true, value: updated };
    },

    async completeAttempt(worker, jobId, input) {
      void worker;
      const job = await repo.findJobById(jobId);
      if (!job) return err("job_not_found", "job does not exist");
      if (job.status !== "running") {
        return err("invalid_transition", `only a running job can complete (state: ${job.status})`);
      }
      const latest = await repo.findLatestAttempt(job.id);
      if (!latest || latest.completedAt !== null) {
        return err("invalid_request", "no open attempt to complete");
      }
      const result = await persistAndAudit<{ job: JobRecord; attempt: JobAttemptRecord }>(
        null,
        "",
        (r) => ({ targetId: r.job.id }),
        async (tx) => {
          const attempt = await tx.completeJobAttempt(latest.id, {
            outcome: "succeeded",
            errorDetail: null,
            progressSnapshot: { progress: input.progress ?? 100 },
            usageRecordId: input.usageRecordId ?? null,
          });
          const updated = await tx.updateJob(job.id, { status: "completed", progress: input.progress ?? 100 });
          return { job: updated, attempt };
        },
      );
      await emit("job.completed", { jobId: result.job.id, attemptId: result.attempt.id, progress: result.job.progress }, { organizationId: job.orgId, jobId: result.job.id });
      return { ok: true, value: result };
    },

    async failAttempt(worker, jobId, input) {
      void worker;
      const outcome: JobAttemptOutcome = input.outcome ?? "failed";
      const job = await repo.findJobById(jobId);
      if (!job) return err("job_not_found", "job does not exist");
      if (job.status !== "running") {
        return err("invalid_transition", `only a running job can fail (state: ${job.status})`);
      }
      const latest = await repo.findLatestAttempt(job.id);
      if (!latest || latest.completedAt !== null) {
        return err("invalid_request", "no open attempt to fail");
      }
      const exhausted = job.attemptCount >= job.maxAttempts;
      // DM section 32.1: failed -> queued while attempts remain (retry);
      // exhausted attempts terminate the job as failed.
      const nextStatus: JobStatus = exhausted ? "failed" : "queued";
      const result = await persistAndAudit<{ job: JobRecord; attempt: JobAttemptRecord }>(
        null,
        "",
        (r) => ({ targetId: r.job.id }),
        async (tx) => {
          const attempt = await tx.completeJobAttempt(latest.id, {
            outcome,
            errorDetail: input.errorDetail,
            progressSnapshot: { progress: job.progress },
            usageRecordId: null,
          });
          const updated = await tx.updateJob(job.id, {
            status: nextStatus,
            lastError: input.errorDetail,
          });
          return { job: updated, attempt };
        },
      );
      await emit("job.failed", { jobId: result.job.id, attemptId: result.attempt.id, outcome, errorDetail: input.errorDetail, nextStatus }, { organizationId: job.orgId, jobId: result.job.id });
      return { ok: true, value: result };
    },

    async recordComputeUsage(actor, input) {
      if (actor !== null) {
        const capFail = requireCapability(actor);
        if (capFail) return capFail;
      }
      if (!input.allocationRef) return err("invalid_request", "allocationRef is required");
      if (!Number.isInteger(input.actualRuntimeSeconds) || input.actualRuntimeSeconds < 0) {
        return err("invalid_request", "actualRuntimeSeconds must be a non-negative integer");
      }
      if (actor === null) {
        return err("invalid_request", "recordComputeUsage requires an actor organization in Stage 2.7");
      }
      const usage = await persistAndAudit<import("./types").ComputeUsageRecord>(
        actor,
        "jobs.compute_usage_recorded",
        (u) => ({ targetId: u.id, metadata: { allocationRef: u.allocationRef } }),
        (tx) =>
          tx.insertComputeUsage({
            orgId: actor.organizationId,
            allocationRef: input.allocationRef,
            actualRuntimeSeconds: input.actualRuntimeSeconds,
            actualCostUsd: input.actualCostUsd,
          }),
      );
      return { ok: true, value: usage };
    },

    async getJob(actor, jobId) {
      const job = await repo.findJobById(jobId);
      if (!job || job.orgId !== actor.organizationId) {
        return err("job_not_found", "job does not exist in your organization");
      }
      return { ok: true, value: job };
    },

    async listJobs(actor, filter) {
      return repo.listJobsByOrg(actor.organizationId, filter);
    },

    async listAttempts(actor, jobId) {
      const job = await repo.findJobById(jobId);
      if (!job || job.orgId !== actor.organizationId) {
        return err("job_not_found", "job does not exist in your organization");
      }
      return { ok: true, value: await repo.listAttemptsByJob(job.id) };
    },
  };
};

/** Placeholder for the system-originated org resolution (unused in 2.7). */
async function failClosedOrg(_input: unknown): Promise<string> {
  throw new Error("enqueueJob requires an actor organization (system-originated enqueue is not supported in Stage 2.7)");
}
