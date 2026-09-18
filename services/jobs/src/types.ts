/**
 * Job-domain service ports (Stage 2.7, decisions D2.7-1..D2.7-5).
 *
 * services/jobs owns the Job/Compute bounded context (SVC section 11 context
 * 9): jobs, job_dependencies, job_attempts, compute_requirements,
 * compute_usage. No vendor or database imports here — this module declares
 * the injectable ports; the Drizzle adapter implements them. Subjects
 * (manifests, generations, publications) stay loose IDs (approved D2).
 * D2.7-4: NO claim/lease/heartbeat API exists — attempts are recorded
 * through this service API only; leases are a Phase-3 worker-runtime concern.
 * D2.7-5: these tables ARE the durable state; events are announcements.
 */
import type { ControlCapability } from "@stratifit/permissions";

/** Operator authorization role (mirrors @stratifit/auth OperatorRole). */
export type OperatorRole = "admin" | "operator" | "reviewer" | "viewer";

/** D2.7-3: the complete documented job type catalog (DM section 16). */
export const JOB_TYPES = [
  "generation.execute",
  "media.process",
  "publication.deliver",
  "notification.send",
  "qc.run",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

/**
 * DM section 32 state machine 2 — explicit states, terminal:
 * completed / failed (attempts exhausted) / cancelled. `created` is the
 * enqueue-time state; queuing moves it to `queued`.
 */
export type JobStatus =
  | "created"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type JobAttemptOutcome = "succeeded" | "failed" | "timed_out" | "cancelled";

/**
 * The approved job state machine (DM section 32.1). Legal edges ONLY —
 * cancellation is an OVERLAY flag on jobs, not a state, and terminal states
 * have no outgoing edges. failed -> queued is the retry path (same
 * idempotency key, invariant 7); running -> queued is the resume path.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  created: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "queued", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

/** States from which a job may not transition (DM section 32.1 terminal). */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled"];

/** Server-derived authorization facts a job command actor must present. */
export interface JobActor {
  /** The acting operator's row id (identity.userId at composition roots). */
  readonly operatorId: string;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
  /** Optional correlation id propagated into audit records. */
  readonly correlationId?: string | null;
}

/**
 * Worker-side command context (D2.7-4: attempt-record API — no leases, no
 * claim protocol). Worker identity is a platform-agnostic reference string;
 * worker credentials are NEVER carried here or persisted (invariant 4).
 */
export interface WorkerContext {
  readonly workerRef: string;
  readonly allocationRef?: string | null;
}

export interface JobRecord {
  readonly id: string;
  readonly orgId: string;
  readonly jobType: JobType;
  readonly idempotencyKey: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly manifestRef: string | null;
  readonly computeRequirementId: string | null;
  readonly status: JobStatus;
  readonly priority: number;
  readonly maxAttempts: number;
  readonly attemptCount: number;
  readonly progress: number;
  readonly lastError: string | null;
  readonly cancellationRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobAttemptRecord {
  readonly id: string;
  readonly orgId: string;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly workerRef: string;
  readonly allocationRef: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly outcome: JobAttemptOutcome | null;
  readonly errorDetail: string | null;
  readonly progressSnapshot: Record<string, unknown>;
  readonly usageRecordId: string | null;
}

export interface ComputeRequirementRecord {
  readonly id: string;
  readonly orgId: string;
  readonly gpuClass: string;
  readonly vramGb: number;
  readonly workers: number;
  readonly concurrency: number;
  readonly estimatedRuntimeSeconds: number;
  readonly storageMb: number;
  readonly estimatedCostUsd: string;
  readonly createdAt: string;
}

export interface ComputeUsageRecord {
  readonly id: string;
  readonly orgId: string;
  readonly allocationRef: string;
  readonly actualRuntimeSeconds: number;
  readonly actualCostUsd: string;
  readonly recordedAt: string;
}

export type JobCommandErrorReason =
  | "missing_capability"
  | "cross_org"
  | "job_not_found"
  | "dependency_not_found"
  | "dependency_cross_org"
  | "self_dependency"
  | "dependency_cycle"
  | "dependency_unresolved"
  | "invalid_request"
  | "invalid_transition"
  | "max_attempts_exhausted";

export type JobCommandError = {
  readonly reason: JobCommandErrorReason;
  readonly message: string;
};

export type JobCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: JobCommandError };

/**
 * Audit entry accepted by the sanctioned admin-audit seam (same shape as the
 * identity D4 seam; composition roots map it to admin-audit's canonical
 * entry). Subject targets stay within the jobs family.
 */
export type JobAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "job" | "compute_requirement" | "compute_usage";
  targetId: string;
  /** Org scope for organization-scoped audit reads (D2.4-2). */
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}) => Promise<void>;

export interface EnqueueJobInput {
  readonly jobType: JobType;
  /** Invariant 7: unique per (org, type); retries dedupe on it. */
  readonly idempotencyKey: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly manifestRef?: string | null;
  readonly computeRequirementId?: string | null;
  readonly priority?: number;
  readonly maxAttempts?: number;
  /** DAG edges: this job starts after each dependency reaches a terminal state. */
  readonly dependsOnJobIds?: readonly string[];
}

/**
 * Transaction-scoped persistence + audit append (D2.4-1, reused not
 * duplicated): every security-critical mutation and its audit record run on
 * the SAME database transaction. Implementations MUST NOT commit or roll
 * back inside `appendAudit` — transaction ownership stays with
 * `runInTransaction`.
 */
export interface JobsTransaction {
  insertJob(input: {
    orgId: string;
    jobType: JobType;
    idempotencyKey: string;
    subjectKind: string;
    subjectId: string;
    manifestRef: string | null;
    computeRequirementId: string | null;
    priority: number;
    maxAttempts: number;
  }): Promise<JobRecord>;
  updateJob(jobId: string, patch: {
    status?: JobStatus;
    attemptCount?: number;
    progress?: number;
    lastError?: string | null;
    cancellationRequested?: boolean;
  }): Promise<JobRecord>;
  insertJobDependency(input: { orgId: string; jobId: string; dependsOnJobId: string }): Promise<void>;
  insertJobAttempt(input: {
    orgId: string;
    jobId: string;
    attemptNumber: number;
    workerRef: string;
    allocationRef: string | null;
  }): Promise<JobAttemptRecord>;
  completeJobAttempt(attemptId: string, patch: {
    outcome: JobAttemptOutcome;
    errorDetail: string | null;
    progressSnapshot: Record<string, unknown>;
    usageRecordId: string | null;
  }): Promise<JobAttemptRecord>;
  /**
   * Option-B channel (Stage 2.7 blocker resolution): progress snapshots are
   * written through the hardened SECURITY DEFINER function
   * record_job_attempt_progress — open attempts only. Must run on the SAME
   * transaction connection.
   */
  recordJobAttemptProgress(attemptId: string, progressSnapshot: Record<string, unknown>): Promise<void>;
  insertComputeUsage(input: {
    orgId: string;
    allocationRef: string;
    actualRuntimeSeconds: number;
    actualCostUsd: string;
  }): Promise<ComputeUsageRecord>;
  appendAudit(entry: Parameters<JobAuditAppend>[0]): Promise<void>;
}

/** Durable job-state port. */
export interface JobsRepository {
  findJobById(id: string): Promise<JobRecord | null>;
  findJobByIdempotencyKey(orgId: string, jobType: JobType, idempotencyKey: string): Promise<JobRecord | null>;
  listJobsByOrg(orgId: string, filter?: { status?: JobStatus; subjectKind?: string; subjectId?: string }): Promise<JobRecord[]>;
  listJobDependencies(jobId: string): Promise<readonly { jobId: string; dependsOnJobId: string }[]>;
  listDependentJobIds(jobId: string): Promise<string[]>;
  listUnresolvedDependencies(jobId: string): Promise<JobRecord[]>;
  findJobAttemptById(id: string): Promise<JobAttemptRecord | null>;
  findLatestAttempt(jobId: string): Promise<JobAttemptRecord | null>;
  listAttemptsByJob(jobId: string): Promise<JobAttemptRecord[]>;
  findComputeRequirementById(id: string): Promise<ComputeRequirementRecord | null>;
  /**
   * Direct (non-transactional) mutations. The jobs service prefers
   * `runInTransaction` whenever it exists; these exist for the TEST-ONLY
   * sequential fallback (D2.4-1) and mirror the MembershipRepository design.
   */
  insertJob(input: {
    orgId: string;
    jobType: JobType;
    idempotencyKey: string;
    subjectKind: string;
    subjectId: string;
    manifestRef: string | null;
    computeRequirementId: string | null;
    priority: number;
    maxAttempts: number;
  }): Promise<JobRecord>;
  updateJob(jobId: string, patch: {
    status?: JobStatus;
    attemptCount?: number;
    progress?: number;
    lastError?: string | null;
    cancellationRequested?: boolean;
  }): Promise<JobRecord>;
  insertJobDependency(input: { orgId: string; jobId: string; dependsOnJobId: string }): Promise<void>;
  insertJobAttempt(input: {
    orgId: string;
    jobId: string;
    attemptNumber: number;
    workerRef: string;
    allocationRef: string | null;
  }): Promise<JobAttemptRecord>;
  completeJobAttempt(attemptId: string, patch: {
    outcome: JobAttemptOutcome;
    errorDetail: string | null;
    progressSnapshot: Record<string, unknown>;
    usageRecordId: string | null;
  }): Promise<JobAttemptRecord>;
  /** See JobsTransaction.recordJobAttemptProgress — Option-B definer channel. */
  recordJobAttemptProgress(attemptId: string, progressSnapshot: Record<string, unknown>): Promise<void>;
  insertComputeUsage(input: {
    orgId: string;
    allocationRef: string;
    actualRuntimeSeconds: number;
    actualCostUsd: string;
  }): Promise<ComputeUsageRecord>;
  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction whose scoped
   * view is `JobsTransaction`. The jobs service uses this path whenever it
   * exists so a security-critical mutation can never commit without its
   * audit record; the sequential fallback is test-only.
   */
  runInTransaction?<T>(work: (tx: JobsTransaction) => Promise<T>): Promise<T>;
}
