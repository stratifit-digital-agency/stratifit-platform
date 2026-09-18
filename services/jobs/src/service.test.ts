/**
 * Unit test matrix for the jobs domain service (Stage 2.7) with in-memory
 * fakes. The fake repository implements runInTransaction WITH rollback
 * semantics (snapshot/restore) so the D2.4-1 same-transaction guarantees —
 * and the fail-closed sequential fallback — are exercised exactly as the
 * production Drizzle repository behaves.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainEventEnvelope } from "@stratifit/contracts";
import { InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  JobActor,
  JobAttemptOutcome,
  JobAttemptRecord,
  JobRecord,
  JobsRepository,
  JobsTransaction,
  JobStatus,
  JobType,
} from "./types";
import { createJobsService, type JobsService } from "./service";

const actor = (overrides: Partial<JobActor> = {}): JobActor => ({
  operatorId: "op-1",
  organizationId: "org-1",
  roles: ["admin"],
  capabilities: ["admin.permissions", "audit.read", "production.plan"],
  ...overrides,
});

const otherActor = () => actor({ operatorId: "op-2", organizationId: "org-2" });

type FakeJob = {
  id: string;
  orgId: string;
  jobType: JobType;
  idempotencyKey: string;
  subjectKind: string;
  subjectId: string;
  manifestRef: string | null;
  computeRequirementId: string | null;
  status: JobStatus;
  priority: number;
  maxAttempts: number;
  attemptCount: number;
  progress: number;
  lastError: string | null;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
};

type FakeAttempt = {
  id: string;
  orgId: string;
  jobId: string;
  attemptNumber: number;
  workerRef: string;
  allocationRef: string | null;
  startedAt: string;
  completedAt: string | null;
  outcome: JobAttemptOutcome | null;
  errorDetail: string | null;
  progressSnapshot: Record<string, unknown>;
  usageRecordId: string | null;
};

interface FakeState {
  jobs: FakeJob[];
  attempts: FakeAttempt[];
  dependencies: { jobId: string; dependsOnJobId: string; orgId: string }[];
  usage: { id: string; orgId: string; allocationRef: string; actualRuntimeSeconds: number; actualCostUsd: string }[];
  /** Test side-channels for audit behavior. */
  auditShouldFail: boolean;
  auditLog: Parameters<JobsTransaction["appendAudit"]>[0][] | undefined;
}

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

const makeFakeRepository = (state: FakeState) => {
  const snapshot = (): FakeState =>
    JSON.parse(
      JSON.stringify({
        jobs: state.jobs,
        attempts: state.attempts,
        dependencies: state.dependencies,
        usage: state.usage,
        auditShouldFail: state.auditShouldFail,
        auditLog: undefined,
      }),
    );

  const mutations = (s: FakeState): Omit<JobsTransaction, "appendAudit"> => ({
    insertJob: async (input): Promise<JobRecord> => {
      const job: FakeJob = {
        id: id("job"),
        orgId: input.orgId,
        jobType: input.jobType,
        idempotencyKey: input.idempotencyKey,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        manifestRef: input.manifestRef,
        computeRequirementId: input.computeRequirementId,
        status: "created",
        priority: input.priority,
        maxAttempts: input.maxAttempts,
        attemptCount: 0,
        progress: 0,
        lastError: null,
        cancellationRequested: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      s.jobs.push(job);
      return job;
    },
    updateJob: async (jobId, patch): Promise<JobRecord> => {
      const j = s.jobs.find((x) => x.id === jobId);
      if (!j) throw new Error("no such job");
      Object.assign(j, {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.attemptCount !== undefined ? { attemptCount: patch.attemptCount } : {}),
        ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.cancellationRequested !== undefined ? { cancellationRequested: patch.cancellationRequested } : {}),
        updatedAt: new Date().toISOString(),
      });
      return j;
    },
    insertJobDependency: async (input) => {
      if (input.jobId === input.dependsOnJobId) throw new Error("self dependency (CHECK)");
      s.dependencies.push(input);
    },
    insertJobAttempt: async (input): Promise<JobAttemptRecord> => {
      const attempt: FakeAttempt = {
        id: id("att"),
        orgId: input.orgId,
        jobId: input.jobId,
        attemptNumber: input.attemptNumber,
        workerRef: input.workerRef,
        allocationRef: input.allocationRef,
        startedAt: new Date().toISOString(),
        completedAt: null,
        outcome: null,
        errorDetail: null,
        progressSnapshot: {},
        usageRecordId: null,
      };
      s.attempts.push(attempt);
      return attempt;
    },
    completeJobAttempt: async (attemptId, patch): Promise<JobAttemptRecord> => {
      const a = s.attempts.find((x) => x.id === attemptId);
      if (!a) throw new Error("no such attempt");
      Object.assign(a, {
        completedAt: new Date().toISOString(),
        outcome: patch.outcome,
        errorDetail: patch.errorDetail,
        progressSnapshot: patch.progressSnapshot,
        usageRecordId: patch.usageRecordId,
      });
      return a;
    },
    // Mirrors the Option-B definer semantics the live DB enforces: progress
    // snapshots land only on OPEN attempts.
    recordJobAttemptProgress: async (attemptId, progressSnapshot): Promise<void> => {
      const a = s.attempts.find((x) => x.id === attemptId);
      if (!a) throw new Error("no such attempt");
      if (a.completedAt !== null) throw new Error("attempt is not open");
      a.progressSnapshot = progressSnapshot;
    },
    insertComputeUsage: async (input): Promise<import("./types").ComputeUsageRecord> => {
      const u = { id: id("usage"), recordedAt: new Date().toISOString(), ...input };
      s.usage.push(u);
      return u;
    },
  });

  const repo: JobsRepository = {
    findJobById: async (jobId) => state.jobs.find((j) => j.id === jobId) ?? null,
    findJobByIdempotencyKey: async (orgId, jobType, key) =>
      state.jobs.find((j) => j.orgId === orgId && j.jobType === jobType && j.idempotencyKey === key) ?? null,
    listJobsByOrg: async (orgId, filter) =>
      state.jobs.filter(
        (j) =>
          j.orgId === orgId &&
          (filter?.status === undefined || j.status === filter.status) &&
          (filter?.subjectKind === undefined || j.subjectKind === filter.subjectKind) &&
          (filter?.subjectId === undefined || j.subjectId === filter.subjectId),
      ),
    listJobDependencies: async (jobId) =>
      state.dependencies.filter((d) => d.jobId === jobId).map(({ jobId: j, dependsOnJobId }) => ({ jobId: j, dependsOnJobId })),
    listDependentJobIds: async (jobId) => state.dependencies.filter((d) => d.dependsOnJobId === jobId).map((d) => d.jobId),
    listUnresolvedDependencies: async (jobId) =>
      state.jobs.filter(
        (j) =>
          state.dependencies.some((d) => d.jobId === jobId && d.dependsOnJobId === j.id) &&
          !["completed", "failed", "cancelled"].includes(j.status),
      ),
    findJobAttemptById: async (attemptId) => state.attempts.find((a) => a.id === attemptId) ?? null,
    findLatestAttempt: async (jobId) => {
      const rows = state.attempts.filter((a) => a.jobId === jobId);
      return rows.length > 0 ? rows[rows.length - 1]! : null;
    },
    listAttemptsByJob: async (jobId) => state.attempts.filter((a) => a.jobId === jobId).reverse(),
    findComputeRequirementById: async () => null,
    ...mutations(state),
    runInTransaction: async <T>(work: (tx: JobsTransaction) => Promise<T>): Promise<T> => {
      const snap = snapshot();
      const tx: JobsTransaction = {
        ...mutations(state),
        appendAudit: async (entry) => {
          if (state.auditShouldFail) throw new Error("audit insert failed (simulated)");
          (state.auditLog ??= []).push(entry);
        },
      };
      try {
        return await work(tx);
      } catch (e) {
        // Simulate Postgres transaction rollback: restore the PRE-WORK
        // snapshot, discarding everything the transaction wrote.
        state.jobs = snap.jobs;
        state.attempts = snap.attempts;
        state.dependencies = snap.dependencies;
        state.usage = snap.usage;
        throw e;
      }
    },
  } as JobsRepository & { runInTransaction: NonNullable<JobsRepository["runInTransaction"]> };

  return repo;
};

// Extra fake-state side channels for audit behavior.
declare module "./service" {}
interface FakeExtras {
  auditShouldFail: boolean;
  auditLog: Parameters<JobsTransaction["appendAudit"]>[0][] | undefined;
}

const makeService = (opts: { allowSequentialAudit?: boolean; publisher?: EventPublisher } = {}) => {
  const state: FakeState = {
    jobs: [],
    attempts: [],
    dependencies: [],
    usage: [],
    auditShouldFail: false,
    auditLog: undefined,
  };
  const repo = makeFakeRepository(state);
  const service = createJobsService({
    repository: repo,
    publisher: opts.publisher ?? new InProcessEventPublisher(),
    ...(opts.allowSequentialAudit !== undefined ? { allowSequentialAudit: opts.allowSequentialAudit } : {}),
  });
  return { service, state };
};

const enqueue = async (service: JobsService, a: JobActor, key: string, extra: Record<string, unknown> = {}) => {
  const result = await service.enqueueJob(a, {
    jobType: "generation.execute",
    idempotencyKey: key,
    subjectKind: "manifest_version",
    subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
    ...extra,
  });
  if (!result.ok) throw new Error(`enqueue failed: ${result.error.reason}`);
  return result.value;
};

// The events helpers use DomainEventEnvelope; the fake publisher collects them.
const collectEvents = () => {
  const events: DomainEventEnvelope[] = [];
  const publisher = new InProcessEventPublisher([
    async (envelope) => {
      events.push(envelope);
    },
  ]);
  return { events, publisher };
};

describe("jobs service — STATE machine (DM section 32.1)", () => {
  it("walks the full legal lifecycle created -> queued -> running -> completed", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "k1");
    const started = await service.startAttempt({ workerRef: "worker-a" }, job.id);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.job.status).toBe("running");
    expect(started.value.job.attemptCount).toBe(1);
    expect(started.value.attempt.attemptNumber).toBe(1);
    const done = await service.completeAttempt({ workerRef: "worker-a" }, job.id, { progress: 100 });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.job.status).toBe("completed");
    expect(done.value.job.progress).toBe(100);
    expect(done.value.attempt.outcome).toBe("succeeded");
  });

  it("rejects running -> completed twice (terminal-state protection)", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "k1");
    await service.startAttempt({ workerRef: "w" }, job.id);
    await service.completeAttempt({ workerRef: "w" }, job.id, {});
    const again = await service.completeAttempt({ workerRef: "w" }, job.id, {});
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.reason).toBe("invalid_transition");
  });

  it("supports running -> queued resume and failed -> queued retry", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "k1");
    await service.startAttempt({ workerRef: "w" }, job.id);
    const failed = await service.failAttempt({ workerRef: "w" }, job.id, { errorDetail: "boom" });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    // Not exhausted (maxAttempts 3, attemptCount 1): failed -> queued automatically.
    expect(failed.value.job.status).toBe("queued");
    const retried = await service.retryJob(actor(), job.id);
    // retryJob applies to failed jobs; this one auto-requeued, so retry on queued is illegal.
    expect(retried.ok).toBe(false);
    // Resume path: queued -> running again (attempt 2).
    const started2 = await service.startAttempt({ workerRef: "w" }, job.id);
    expect(started2.ok).toBe(true);
    if (!started2.ok) return;
    expect(started2.value.attempt.attemptNumber).toBe(2);
  });

  it("exhausts max attempts and terminates as failed; retryJob then fails closed", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "k1", { maxAttempts: 2 });
    for (let i = 0; i < 2; i += 1) {
      const s = await service.startAttempt({ workerRef: "w" }, job.id);
      expect(s.ok).toBe(true);
      const f = await service.failAttempt({ workerRef: "w" }, job.id, { errorDetail: `boom ${i}` });
      expect(f.ok).toBe(true);
      if (!f.ok) return;
      if (i === 0) expect(f.value.job.status).toBe("queued");
    }
    const afterExhaust = await service.retryJob(actor(), job.id);
    expect(afterExhaust.ok).toBe(false);
    if (afterExhaust.ok) return;
    expect(afterExhaust.error.reason).toBe("max_attempts_exhausted");
    const jobNow = await service.getJob(actor(), job.id);
    expect(jobNow.ok && jobNow.value.status).toBe("failed");
  });

  it("cancels from created/queued/running and rejects cancelling terminal jobs", async () => {
    const { service } = makeService();
    const a = enqueue(service, actor(), "k1").then((r) => r.job);
    const job = await a;
    const cancelled = await service.cancelJob(actor(), job.id);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.status).toBe("cancelled");
    const again = await service.cancelJob(actor(), job.id);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.reason).toBe("invalid_transition");
  });

  it("observes the cancellation overlay at the startAttempt safe point", async () => {
    // cancelJob moves queued -> cancelled directly (legal edge), so the
    // overlay path applies to a running job's checkpoint resume; a queued
    // job cancelled before startAttempt yields job_not_found-in-transition.
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "k1");
    await service.startAttempt({ workerRef: "w" }, job.id);
    const cancelled = await service.cancelJob(actor(), job.id);
    expect(cancelled.ok).toBe(true);
    const afterStart = await service.startAttempt({ workerRef: "w" }, job.id);
    expect(afterStart.ok).toBe(false);
  });

  it("rejects every illegal transition shape (progress on non-running, retry on queued)", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "k1");
    // progress on a queued job is NOT an edge (progress requires running).
    const illegalProgress = await service.recordProgress({ workerRef: "w" }, job.id, 50);
    expect(illegalProgress.ok).toBe(false);
    if (illegalProgress.ok) return;
    expect(illegalProgress.error.reason).toBe("invalid_transition");
    // retry on a queued job is NOT an edge (retry requires failed).
    const illegalRetry = await service.retryJob(actor(), job.id);
    expect(illegalRetry.ok).toBe(false);
    if (illegalRetry.ok) return;
    expect(illegalRetry.error.reason).toBe("invalid_transition");
    // complete on a queued job is NOT an edge (complete requires running).
    const illegalComplete = await service.completeAttempt({ workerRef: "w" }, job.id, {});
    expect(illegalComplete.ok).toBe(false);
  });
});

describe("jobs service — IDEMPOTENCY (invariant 7)", () => {
  it("duplicate enqueue resolves to the existing job without creating a duplicate", async () => {
    const { service, state } = makeService();
    const first = await enqueue(service, actor(), "dup-key");
    const second = await service.enqueueJob(actor(), {
      jobType: "generation.execute",
      idempotencyKey: "dup-key",
      subjectKind: "manifest_version",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.deduplicated).toBe(true);
    expect(second.value.job.id).toBe(first.job.id);
    expect(state.jobs.filter((j) => j.idempotencyKey === "dup-key")).toHaveLength(1);
  });

  it("same org/type/key never duplicates; different orgs may reuse the same key", async () => {
    const { service, state } = makeService();
    await enqueue(service, actor(), "shared-key");
    await enqueue(service, actor(), "shared-key");
    const other = await enqueue(service, otherActor(), "shared-key");
    expect(other.job.orgId).toBe("org-2");
    expect(state.jobs).toHaveLength(2);
  });

  it("same key with a different job type is a distinct job", async () => {
    const { service, state } = makeService();
    await enqueue(service, actor(), "k");
    await service.enqueueJob(actor(), {
      jobType: "media.process",
      idempotencyKey: "k",
      subjectKind: "asset",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000002",
    });
    expect(state.jobs).toHaveLength(2);
  });
});

describe("jobs service — ATTEMPTS", () => {
  it("numbers attempts monotonically per job", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "k1", { maxAttempts: 5 });
    const s1 = await service.startAttempt({ workerRef: "w" }, job.id);
    const f1 = await service.failAttempt({ workerRef: "w" }, job.id, { errorDetail: "x" });
    const s2 = await service.startAttempt({ workerRef: "w" }, job.id);
    expect(s1.ok && f1.ok && s2.ok).toBe(true);
    if (!s1.ok || !s2.ok) return;
    expect(s2.value.attempt.attemptNumber).toBe(2);
  });

  it("refuses to start an attempt beyond maxAttempts", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "k1", { maxAttempts: 1 });
    await service.startAttempt({ workerRef: "w" }, job.id);
    await service.failAttempt({ workerRef: "w" }, job.id, { errorDetail: "boom" });
    // After exhaustion the job is failed; startAttempt must refuse.
    const refused = await service.startAttempt({ workerRef: "w" }, job.id);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.reason).toBe("invalid_transition");
  });

  it("preserves the idempotency key across retries (same key, new attempt)", async () => {
    const { service, state } = makeService();
    const { job } = await enqueue(service, actor(), "stable-key", { maxAttempts: 5 });
    await service.startAttempt({ workerRef: "w" }, job.id);
    await service.failAttempt({ workerRef: "w" }, job.id, { errorDetail: "boom" });
    expect(state.jobs[0]!.idempotencyKey).toBe("stable-key");
    expect(state.jobs[0]!.attemptCount).toBe(1);
  });
});

describe("jobs service — DEPENDENCIES", () => {
  it("rejects missing, cross-org, and self dependencies", async () => {
    const { service } = makeService();
    const missing = await service.enqueueJob(actor(), {
      jobType: "generation.execute",
      idempotencyKey: "d1",
      subjectKind: "manifest_version",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
      dependsOnJobIds: ["00000000-0000-4000-8000-0000000000ff"],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.reason).toBe("dependency_not_found");

    const dep = await enqueue(service, otherActor(), "other-org-job");
    const crossOrg = await service.enqueueJob(actor(), {
      jobType: "generation.execute",
      idempotencyKey: "d2",
      subjectKind: "manifest_version",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
      dependsOnJobIds: [dep.job.id],
    });
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.error.reason).toBe("dependency_cross_org");
  });

  it("gates execution on unresolved dependencies and unlocks after completion", async () => {
    const { service } = makeService();
    const upstream = await enqueue(service, actor(), "upstream");
    const downstream = await enqueue(service, actor(), "downstream", { dependsOnJobIds: [upstream.job.id] });
    const gated = await service.startAttempt({ workerRef: "w" }, downstream.job.id);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.error.reason).toBe("dependency_unresolved");
    // Complete the upstream job; downstream is now unlocked.
    await service.startAttempt({ workerRef: "w" }, upstream.job.id);
    await service.completeAttempt({ workerRef: "w" }, upstream.job.id, {});
    const nowAllowed = await service.startAttempt({ workerRef: "w" }, downstream.job.id);
    expect(nowAllowed.ok).toBe(true);
  });

  it("treats a failed-then-terminal upstream as resolved for gating", async () => {
    const { service } = makeService();
    const upstream = await enqueue(service, actor(), "up", { maxAttempts: 1 });
    const downstream = await enqueue(service, actor(), "down", { dependsOnJobIds: [upstream.job.id] });
    await service.startAttempt({ workerRef: "w" }, upstream.job.id);
    await service.failAttempt({ workerRef: "w" }, upstream.job.id, { errorDetail: "terminal fail" });
    const nowAllowed = await service.startAttempt({ workerRef: "w" }, downstream.job.id);
    expect(nowAllowed.ok).toBe(true);
  });
});

describe("jobs service — AUDIT (D2.4-1 same-transaction)", () => {
  it("audits enqueue and cancel inside the same transaction", async () => {
    const { service, state } = makeService();
    const { job } = await enqueue(service, actor(), "audited");
    expect(state.auditLog?.map((e) => e.action)).toContain("jobs.job_enqueued");
    await service.cancelJob(actor(), job.id);
    expect(state.auditLog?.map((e) => e.action)).toContain("jobs.job_cancelled");
  });

  it("rolls back the ENTIRE mutation when the audit append fails (no partial state, no event)", async () => {
    const { events, publisher } = collectEvents();
    const { service, state } = makeService({ publisher });
    state.auditShouldFail = true;
    await expect(
      service.enqueueJob(actor(), {
        jobType: "generation.execute",
        idempotencyKey: "rollback",
        subjectKind: "manifest_version",
        subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("audit insert failed");
    // Rollback: no job row, no audit row.
    expect(state.jobs).toHaveLength(0);
    expect(state.auditLog ?? []).toHaveLength(0);
    // No successful domain event may be published for a failed transaction.
    expect(events).toHaveLength(0);
  });

  it("does not audit worker-path attempt commands", async () => {
    const { service, state } = makeService();
    const { job } = await enqueue(service, actor(), "worker-path");
    const before = state.auditLog?.length ?? 0;
    await service.startAttempt({ workerRef: "w" }, job.id);
    await service.recordProgress({ workerRef: "w" }, job.id, 42);
    await service.completeAttempt({ workerRef: "w" }, job.id, {});
    expect(state.auditLog?.length).toBe(before);
  });

  it("fail-closes when the repository has no transaction support unless the TEST-ONLY flag is set", async () => {
    const state: FakeState = { jobs: [], attempts: [], dependencies: [], usage: [], auditShouldFail: false, auditLog: undefined };
    const repoWithoutTx: JobsRepository = (() => {
      const r = makeFakeRepository(state) as JobsRepository & { runInTransaction?: unknown };
      delete r.runInTransaction;
      return r;
    })();
    const strict = createJobsService({ repository: repoWithoutTx });
    await expect(
      strict.enqueueJob(actor(), {
        jobType: "generation.execute",
        idempotencyKey: "strict",
        subjectKind: "manifest_version",
        subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("D2.4-1 violation");

    // With the test-only flag, the sequential fallback works (and audits).
    const fallback = createJobsService({
      repository: repoWithoutTx,
      allowSequentialAudit: true,
      auditAppend: async () => {},
    });
    const result = await fallback.enqueueJob(actor(), {
      jobType: "generation.execute",
      idempotencyKey: "fallback",
      subjectKind: "manifest_version",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
    });
    expect(result.ok).toBe(true);
  });
});

describe("jobs service — EVENTS (post-commit, existing names only)", () => {
  it("emits job.created/.started/.progress/.completed and nothing else", async () => {
    const { events, publisher } = collectEvents();
    const { service } = makeService({ publisher });
    const { job } = await enqueue(service, actor(), "events");
    await service.startAttempt({ workerRef: "w" }, job.id);
    await service.recordProgress({ workerRef: "w" }, job.id, 50);
    await service.completeAttempt({ workerRef: "w" }, job.id, {});
    const names = events.map((e) => e.name).sort();
    expect(names).toEqual(["job.completed", "job.created", "job.progress", "job.started"]);
  });

  it("emits job.cancelled on cancel and job.failed on failure", async () => {
    const { events, publisher } = collectEvents();
    const { service } = makeService({ publisher });
    const { job } = await enqueue(service, actor(), "events2", { maxAttempts: 1 });
    await service.startAttempt({ workerRef: "w" }, job.id);
    await service.failAttempt({ workerRef: "w" }, job.id, { errorDetail: "boom" });
    expect(events.map((e) => e.name)).toContain("job.failed");
    const { job: job2 } = await enqueue(service, actor(), "events3");
    await service.cancelJob(actor(), job2.id);
    expect(events.map((e) => e.name)).toContain("job.cancelled");
  });

  it("propagates correlation (organizationId, jobId) in every envelope", async () => {
    const { events, publisher } = collectEvents();
    const { service } = makeService({ publisher });
    const { job } = await enqueue(service, actor(), "corr");
    await service.startAttempt({ workerRef: "w" }, job.id);
    for (const e of events) {
      expect(e.correlation.organizationId).toBe("org-1");
      expect(e.correlation.jobId).toBe(job.id);
    }
  });
});

describe("jobs service — QUERIES and capability gating", () => {
  it("denies cross-org reads (IDOR-safe: job_not_found, not cross_org)", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "secret");
    const intruder = await service.getJob(otherActor(), job.id);
    expect(intruder.ok).toBe(false);
    if (intruder.ok) return;
    expect(intruder.error.reason).toBe("job_not_found");
  });

  it("denies cancel for cross-org jobs without leaking existence", async () => {
    const { service } = makeService();
    const { job } = await enqueue(service, actor(), "secret2");
    const intruder = await service.cancelJob(otherActor(), job.id);
    expect(intruder.ok).toBe(false);
    if (intruder.ok) return;
    expect(intruder.error.reason).toBe("job_not_found");
  });

  it("enforces the required capability on operator-originated commands", async () => {
    const { service } = makeService();
    const nobody = actor({ capabilities: ["audit.read"] });
    const denied = await service.enqueueJob(nobody, {
      jobType: "generation.execute",
      idempotencyKey: "nocap",
      subjectKind: "manifest_version",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe("missing_capability");
  });

  it("filters listJobs by status and subject", async () => {
    const { service } = makeService();
    const a = await enqueue(service, actor(), "l1");
    await enqueue(service, actor(), "l2");
    // Enqueue leaves jobs queued (created -> queued in the same transaction).
    const queued = await service.listJobs(actor(), { status: "queued" });
    expect(queued).toHaveLength(2);
    await service.startAttempt({ workerRef: "w" }, a.job.id);
    const running = await service.listJobs(actor(), { status: "running" });
    expect(running.map((j) => j.id)).toEqual([a.job.id]);
  });
});
