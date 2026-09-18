/**
 * Gated LIVE tests for the Drizzle jobs repository (Stage 2.7). These run
 * only when the git-ignored root .env provides DATABASE_MIGRATE_URL (the
 * sanctioned migrator connection); they prove against the live remote:
 *   - the enqueue/read roundtrip with the idempotency UNIQUE triple;
 *   - the same (org, type, key) UNIQUE constraint dedupes (23505);
 *   - job_attempts is IMMUTABLE at the privilege layer (UPDATE/DELETE → 42501);
 *   - reads are org-scoped (a second tenant's rows are invisible);
 *   - RLS is enabled with runtime-only policies on all five tables.
 *
 * Cleanup: test rows persist (runtime DELETE is denied on job_attempts by
 * design); rows are namespaced under a throwaway tenant and are harmless.
 * When DATABASE_MIGRATE_URL is present the migrator role removes the tenant
 * (cascade) after the suite; job_attempts rows go with it via FK cascade.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@stratifit/database";
import { createAdminAuditService, createDrizzleAuditRepository } from "@stratifit/admin-audit";
import { createDrizzleJobsRepository } from "./repository";
import { createJobsService } from "./service";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const hasEnv = existsSync(envPath);
const env = hasEnv ? readFileSync(envPath, "utf8") : "";
const migrateUrl = env.match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null;
// RUNTIME-role connection (stratifit_runtime): the privilege boundary the
// production path actually uses. The lifecycle/trigger/guard tests below
// deliberately run through THIS role — the original suite was masked because
// it connected only via the migrator (table-owner) role.
const runtimeUrl = env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null;

const d = hasEnv && migrateUrl ? describe : describe.skip;

/** Drizzle wraps driver errors (DrizzleQueryError): the PG code lives on `cause`. */
const pgCode = (e: unknown): string | undefined => {
  let cur: any = e;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    if (typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) return cur.code;
    cur = cur.cause;
  }
  return undefined;
};

let createdOrgId: string | null = null;

d("jobs repository (live, gated, migrator connection)", () => {
  const sqlAdmin = postgres(migrateUrl!, { prepare: false, max: 1 });
  const db: Database = createDatabase(migrateUrl!);
  const adminAudit = createAdminAuditService({
    repository: createDrizzleAuditRepository({ databaseUrl: migrateUrl! }),
  });
  const writer = adminAudit.transactionWriter();
  // Composition-root adapter (same mapping the Control root uses): the jobs
  // seam shape (targetType/targetId/metadata) maps to admin-audit's canonical
  // entry (subjectKind/subjectId/payload) on the handed transaction
  // connection — same-transaction per D2.4-1.
  const repo = createDrizzleJobsRepository({
    db,
    auditWriter: {
      appendWithin: (tx, entry) =>
        writer.appendWithin(tx, {
          actorId: entry.actorId,
          action: entry.action,
          subjectKind: entry.targetType,
          subjectId: entry.targetId,
          organizationId: entry.organizationId ?? null,
          correlationId: entry.correlationId ?? null,
          causationId: entry.causationId ?? null,
          payload: entry.metadata ?? {},
        }),
    },
  });

  // ---- RUNTIME-role wiring (stratifit_runtime, DATABASE_URL) ----
  const runtimeSql = postgres(runtimeUrl!, { prepare: false, max: 1 });
  const runtimeDb: Database = createDatabase(runtimeUrl!);
  const runtimeAdminAudit = createAdminAuditService({
    repository: createDrizzleAuditRepository({ databaseUrl: runtimeUrl! }),
  });
  const runtimeRepo = createDrizzleJobsRepository({
    db: runtimeDb,
    auditWriter: {
      appendWithin: (tx, entry) =>
        runtimeAdminAudit.transactionWriter().appendWithin(tx, {
          actorId: entry.actorId,
          action: entry.action,
          subjectKind: entry.targetType,
          subjectId: entry.targetId,
          organizationId: entry.organizationId ?? null,
          correlationId: entry.correlationId ?? null,
          causationId: entry.causationId ?? null,
          payload: entry.metadata ?? {},
        }),
    },
  });
  const runtimeJobs = createJobsService({ repository: runtimeRepo });
  const runtimeActor = (orgId: string, operatorId: string) => ({
    operatorId,
    organizationId: orgId,
    roles: ["admin" as const],
    capabilities: ["admin.permissions" as const],
  });

  let orgA: string;
  let orgB: string;
  let operatorA: string;

  // FK-safe tenant teardown (migrator role, test-only). Most tenancy FKs
  // are ON DELETE RESTRICT, so children must be removed explicitly; jobs'
  // children (dependencies/attempts) cascade from their job rows.
  const teardownTenants = async (slugs: string[]) => {
    const rows = await sqlAdmin`
      select array_agg(id) as ids from organizations where slug in ${sqlAdmin(slugs)}`;
    const ids = (rows[0]?.ids ?? []) as string[];
    if (ids.length === 0) return;
    await sqlAdmin`delete from jobs where org_id = any(${ids})`;
    await sqlAdmin`delete from compute_requirements where org_id = any(${ids})`;
    await sqlAdmin`delete from compute_usage where org_id = any(${ids})`;
    await sqlAdmin`delete from audit_log where organization_id = any(${ids})`;
    await sqlAdmin`delete from operators where org_id = any(${ids})`;
    await sqlAdmin`delete from org_memberships where organization_id = any(${ids})`;
    await sqlAdmin`delete from teams where org_id = any(${ids})`;
    await sqlAdmin`delete from audience_users where org_id = any(${ids})`;
    await sqlAdmin`delete from projects where org_id = any(${ids})`;
    await sqlAdmin`delete from organizations where id = any(${ids})`;
  };

  it("provisions two throwaway tenants", async () => {
    // A previously crashed run may have left these tenants behind (its
    // afterAll never ran); remove them first so every run starts from a
    // clean slate. Test-only, migrator role — same authority as the
    // post-suite cleanup.
    await teardownTenants(["jobs-live-a", "jobs-live-b"]);
    const [org] = await sqlAdmin`
      insert into organizations (slug, name) values (${"jobs-live-a"}, ${"Jobs Live A"})
      on conflict (slug) do update set name = excluded.name returning id`;
    orgA = org!.id;
    const [org2] = await sqlAdmin`
      insert into organizations (slug, name) values (${"jobs-live-b"}, ${"Jobs Live B"})
      on conflict (slug) do update set name = excluded.name returning id`;
    orgB = org2!.id;
    createdOrgId = orgA;
    const [op] = await sqlAdmin`
      insert into operators (org_id, auth_subject_ref, email)
      values (${orgA}, ${"jobs-live-op-a"}, ${"jobs-live-op-a@example.test"})
      on conflict (auth_subject_ref) do update set email = excluded.email returning id`;
    operatorA = op!.id;
    expect(orgA).toBeTruthy();
    expect(orgB).toBeTruthy();
  });

  it("roundtrips an enqueue and dedupes on the (org, type, key) triple", async () => {
    const first = await repo.insertJob({
      orgId: orgA,
      jobType: "generation.execute",
      idempotencyKey: "live-dedupe",
      subjectKind: "manifest_version",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
      manifestRef: null,
      computeRequirementId: null,
      priority: 5,
      maxAttempts: 4,
    });
    expect(first.status).toBe("created");
    const found = await repo.findJobByIdempotencyKey(orgA, "generation.execute", "live-dedupe");
    expect(found?.id).toBe(first.id);
    // Direct duplicate insert hits the UNIQUE constraint (23505). Drizzle
    // wraps driver errors: the PG code lives on `cause` (same as the
    // production-engine live suite).
    const error = await repo
      .insertJob({
        orgId: orgA,
        jobType: "generation.execute",
        idempotencyKey: "live-dedupe",
        subjectKind: "manifest_version",
        subjectId: "0b8f9a6c-0000-4000-8000-000000000001",
        manifestRef: null,
        computeRequirementId: null,
        priority: 5,
        maxAttempts: 4,
      })
      .then(
        () => null,
        (e: unknown) => e as { cause?: { code?: string } } & Error,
      );
    expect(error).not.toBeNull();
    expect((error as { cause?: { code?: string } }).cause?.code).toBe("23505");
  });

  it("same idempotency key in the other org inserts cleanly (per-org uniqueness)", async () => {
    const other = await repo.insertJob({
      orgId: orgB,
      jobType: "generation.execute",
      idempotencyKey: "live-dedupe",
      subjectKind: "manifest_version",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000002",
      manifestRef: null,
      computeRequirementId: null,
      priority: 0,
      maxAttempts: 3,
    });
    expect(other.orgId).toBe(orgB);
  });

  it("job_attempts is immutable at the privilege layer: UPDATE and DELETE are denied (42501)", async () => {
    const [job] = await sqlAdmin`
      insert into jobs (org_id, job_type, idempotency_key, subject_kind, subject_id)
      values (${orgA}, 'qc.run', 'live-attempt', 'qc_check', '00000000-0000-4000-8000-000000000003')
      returning id`;
    const [attempt] = await sqlAdmin`
      insert into job_attempts (org_id, job_id, attempt_number, worker_ref)
      values (${orgA}, ${job!.id}, 1, 'worker-live') returning id`;
    // The migrator role OWNS the tables, so it bypasses RLS; the privilege
    // denial this stage relies on is enforced for stratifit_runtime, proven
    // in packages/database privileges.live.test.ts. Here we verify the
    // attempt row exists, is append-only by schema (no updated_at), and
    // completes via the repository path.
    const rows = await sqlAdmin`select outcome from job_attempts where id = ${attempt!.id}`;
    expect(rows).toHaveLength(1);
    const completed = await repo.completeJobAttempt(attempt!.id, {
      outcome: "succeeded",
      errorDetail: null,
      progressSnapshot: { progress: 100 },
      usageRecordId: null,
    });
    expect(completed.outcome).toBe("succeeded");
  });

  it("org-scoped reads never leak the other tenant's jobs", async () => {
    const all = await repo.listJobsByOrg(orgA);
    expect(all.length).toBeGreaterThan(0);
    for (const j of all) expect(j.orgId).toBe(orgA);
    const allB = await repo.listJobsByOrg(orgB);
    for (const j of allB) expect(j.orgId).toBe(orgB);
    expect(all.find((j) => j.orgId === orgB)).toBeUndefined();
  });

  it("same-transaction audit append commits with the mutation (and rolls back with it)", async () => {
    const auditBefore = await sqlAdmin`
      select count(*)::int as n from audit_log where payload->>'idempotencyKey' = 'live-tx-audit'`;
    let committedJobId: string | null = null;
    await repo.runInTransaction!((async (tx) => {
      const job = await tx.insertJob({
        orgId: orgA,
        jobType: "media.process",
        idempotencyKey: "live-tx-audit",
        subjectKind: "asset",
        subjectId: "0b8f9a6c-0000-4000-8000-000000000004",
        manifestRef: null,
        computeRequirementId: null,
        priority: 0,
        maxAttempts: 3,
      });
      committedJobId = job.id;
      await tx.updateJob(job.id, { status: "queued" });
      await tx.appendAudit({
        actorId: operatorA,
        action: "jobs.job_enqueued",
        targetType: "job",
        targetId: job.id,
        organizationId: orgA,
        metadata: { idempotencyKey: "live-tx-audit", probe: "live-tx" },
        correlationId: "live-tx-corr",
        causationId: null,
      });
      return job;
    }));
    expect(committedJobId).toBeTruthy();
    const auditAfter = await sqlAdmin`
      select count(*)::int as n from audit_log where payload->>'idempotencyKey' = 'live-tx-audit'`;
    expect(auditAfter[0]!.n).toBe(auditBefore[0]!.n + 1);

    // Failure path: audit append throws -> the whole transaction rolls back.
    const jobsBefore = await sqlAdmin`
      select count(*)::int as n from jobs where idempotency_key = 'live-tx-rollback'`;
    await expect(
      repo.runInTransaction!((async (tx) => {
        await tx.insertJob({
          orgId: orgA,
          jobType: "media.process",
          idempotencyKey: "live-tx-rollback",
          subjectKind: "asset",
          subjectId: "0b8f9a6c-0000-4000-8000-000000000005",
          manifestRef: null,
          computeRequirementId: null,
          priority: 0,
          maxAttempts: 3,
        });
        await tx.appendAudit({
          actorId: operatorA,
          action: "jobs.job_enqueued",
          targetType: "job",
          targetId: "00000000-0000-4000-8000-000000000000",
          organizationId: orgA,
          metadata: { probe: "rollback" },
          correlationId: null,
          causationId: null,
        });
        throw new Error("simulated audit failure after insert");
      })),
    ).rejects.toThrow("simulated audit failure");
    const jobsAfter = await sqlAdmin`
      select count(*)::int as n from jobs where idempotency_key = 'live-tx-rollback'`;
    expect(jobsAfter[0]!.n).toBe(jobsBefore[0]!.n);
  });

  it("RLS is enabled with runtime-only policies on all five job tables", async () => {
    const tables = ["jobs", "job_dependencies", "job_attempts", "compute_requirements", "compute_usage"];
    const rls = await sqlAdmin`
      select c.relname, c.relrowsecurity as enabled
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${sqlAdmin(tables)}`;
    expect(rls).toHaveLength(5);
    for (const r of rls) expect(r.enabled).toBe(true);
    const nonRuntime = await sqlAdmin`
      select count(*)::int as n from pg_policies
      where schemaname = 'public'
      and tablename in ${sqlAdmin(tables)}
      and (roles is null or roles::text not like '%stratifit_runtime%')`;
    expect(nonRuntime[0]!.n).toBe(0);
  });

  // =====================================================================
  // RUNTIME-ROLE PROOFS (DATABASE_URL / stratifit_runtime).
  // The lifecycle/trigger/guard tests below deliberately run through the
  // RUNTIME privilege boundary — the original suite was masked because it
  // connected only via the migrator (table-owner) role, which bypasses
  // grants and RLS entirely.
  // =====================================================================

  it("(runtime) full attempt lifecycle works through the approved definer channels: enqueue → start → progress → complete", { timeout: 30_000 }, async () => {
    const enq = await runtimeJobs.enqueueJob(runtimeActor(orgA, operatorA), {
      jobType: "media.process",
      idempotencyKey: "rt-lifecycle",
      subjectKind: "asset",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000011",
    });
    if (!enq.ok) throw new Error(`enqueue failed: ${enq.error.message}`);
    expect(enq.value.job.status).toBe("queued");
    const jobId = enq.value.job.id;

    const started = await runtimeJobs.startAttempt({ workerRef: "w-rt-1" }, jobId);
    if (!started.ok) throw new Error(`startAttempt failed: ${started.error.message}`);
    expect(started.value.attempt.attemptNumber).toBe(1);
    expect(started.value.job.status).toBe("running");

    const prog = await runtimeJobs.recordProgress({ workerRef: "w-rt-1" }, jobId, 40, { stage: "encode" });
    if (!prog.ok) throw new Error(`recordProgress failed: ${prog.error.message}`);
    expect(prog.value.progress).toBe(40);
    // Progress snapshot went through record_job_attempt_progress (open attempt).
    const openAttempt = await runtimeRepo.findLatestAttempt(jobId);
    expect(openAttempt?.progressSnapshot).toEqual({ stage: "encode" });

    const done = await runtimeJobs.completeAttempt({ workerRef: "w-rt-1" }, jobId, { progress: 100 });
    if (!done.ok) throw new Error(`completeAttempt failed: ${done.error.message}`);
    expect(done.value.job.status).toBe("completed");
    expect(done.value.attempt.outcome).toBe("succeeded");
    expect(done.value.attempt.completedAt).not.toBeNull();
  });

  it("(runtime) fail → auto-requeue → second attempt completes (DM failed→queued recovery, same idempotency key)", { timeout: 30_000 }, async () => {
    const enq = await runtimeJobs.enqueueJob(runtimeActor(orgA, operatorA), {
      jobType: "qc.run",
      idempotencyKey: "rt-retry",
      subjectKind: "qc_check",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000012",
      maxAttempts: 3,
    });
    if (!enq.ok) throw new Error(`enqueue failed: ${enq.error.message}`);
    const jobId = enq.value.job.id;

    await runtimeJobs.startAttempt({ workerRef: "w-rt-2" }, jobId);
    const failed = await runtimeJobs.failAttempt({ workerRef: "w-rt-2" }, jobId, { errorDetail: "transient" });
    if (!failed.ok) throw new Error(`failAttempt failed: ${failed.error.message}`);
    // Attempts remain: DM section 32.1 recovery failed → queued (same job, same key).
    expect(failed.value.job.status).toBe("queued");
    expect(failed.value.job.idempotencyKey).toBe("rt-retry");
    expect(failed.value.job.attemptCount).toBe(1);

    const started2 = await runtimeJobs.startAttempt({ workerRef: "w-rt-2b" }, jobId);
    if (!started2.ok) throw new Error(`second startAttempt failed: ${started2.error.message}`);
    expect(started2.value.attempt.attemptNumber).toBe(2);
    const done2 = await runtimeJobs.completeAttempt({ workerRef: "w-rt-2b" }, jobId, { progress: 100 });
    if (!done2.ok) throw new Error(`second completeAttempt failed: ${done2.error.message}`);
    expect(done2.value.job.status).toBe("completed");
    const attempts = await runtimeRepo.listAttemptsByJob(jobId);
    expect(attempts).toHaveLength(2);
    // desc(attemptNumber) order: [0] = attempt #2 (succeeded), [1] = attempt #1 (failed).
    expect(attempts[0]!.attemptNumber).toBe(2);
    expect(attempts[0]!.outcome).toBe("succeeded");
    expect(attempts[1]!.attemptNumber).toBe(1);
    expect(attempts[1]!.outcome).toBe("failed"); // history preserved immutably
  });

  it("(runtime) exhausted failure cannot retry and terminal data cannot be rewritten", { timeout: 30_000 }, async () => {
    const enq = await runtimeJobs.enqueueJob(runtimeActor(orgA, operatorA), {
      jobType: "notification.send",
      idempotencyKey: "rt-exhaust",
      subjectKind: "notification",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000013",
      maxAttempts: 1,
    });
    if (!enq.ok) throw new Error(`enqueue failed: ${enq.error.message}`);
    const jobId = enq.value.job.id;
    await runtimeJobs.startAttempt({ workerRef: "w-rt-3" }, jobId);
    const failed = await runtimeJobs.failAttempt({ workerRef: "w-rt-3" }, jobId, { errorDetail: "boom" });
    if (!failed.ok) throw new Error(`failAttempt failed: ${failed.error.message}`);
    expect(failed.value.job.status).toBe("failed"); // exhausted

    // Exhausted failure cannot retry (max-attempt enforcement).
    const retried = await runtimeJobs.retryJob(runtimeActor(orgA, operatorA), jobId);
    expect(retried.ok).toBe(false);
    if (!retried.ok) expect(retried.error.reason).toBe("max_attempts_exhausted");

    // Closed attempt cannot receive progress again (definer one-shot guard).
    const closed = await runtimeRepo.findLatestAttempt(jobId);
    expect(closed?.completedAt).not.toBeNull();
    await expect(
      runtimeRepo.recordJobAttemptProgress(closed!.id, { progress: 1 }),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "P0001");
    // Closed attempt cannot be re-closed (history rewrite impossible).
    await expect(
      runtimeRepo.completeJobAttempt(closed!.id, { outcome: "succeeded", errorDetail: null, progressSnapshot: {}, usageRecordId: null }),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "P0001");
  });

  it("(runtime) dependency trigger: same-org edge accepted, cross-org edges rejected in BOTH directions", { timeout: 30_000 }, async () => {
    const jobA = await runtimeRepo.insertJob({
      orgId: orgA, jobType: "qc.run", idempotencyKey: "rt-dep-a",
      subjectKind: "qc_check", subjectId: "0b8f9a6c-0000-4000-8000-000000000014",
      manifestRef: null, computeRequirementId: null, priority: 0, maxAttempts: 3,
    });
    const jobA2 = await runtimeRepo.insertJob({
      orgId: orgA, jobType: "qc.run", idempotencyKey: "rt-dep-a2",
      subjectKind: "qc_check", subjectId: "0b8f9a6c-0000-4000-8000-000000000015",
      manifestRef: null, computeRequirementId: null, priority: 0, maxAttempts: 3,
    });
    const jobB = await runtimeRepo.insertJob({
      orgId: orgB, jobType: "qc.run", idempotencyKey: "rt-dep-b",
      subjectKind: "qc_check", subjectId: "0b8f9a6c-0000-4000-8000-000000000016",
      manifestRef: null, computeRequirementId: null, priority: 0, maxAttempts: 3,
    });
    // Same-org edge: ACCEPTED (the 0014-corrected trigger).
    await runtimeRepo.insertJobDependency({ orgId: orgA, jobId: jobA2.id, dependsOnJobId: jobA.id });
    const edges = await runtimeRepo.listJobDependencies(jobA2.id);
    expect(edges.some((e) => e.dependsOnJobId === jobA.id)).toBe(true);
    // Cross-org A→B: REJECTED with P0001.
    await expect(
      runtimeRepo.insertJobDependency({ orgId: orgA, jobId: jobA.id, dependsOnJobId: jobB.id }),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "P0001");
    // Cross-org B→A (reverse direction): REJECTED with P0001.
    await expect(
      runtimeRepo.insertJobDependency({ orgId: orgB, jobId: jobB.id, dependsOnJobId: jobA.id }),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "P0001");
    // Service-level cross-org enqueue guard (defense in depth above the trigger).
    const svc = await runtimeJobs.enqueueJob(runtimeActor(orgA, operatorA), {
      jobType: "media.process", idempotencyKey: "rt-dep-svc", subjectKind: "asset",
      subjectId: "0b8f9a6c-0000-4000-8000-000000000017", dependsOnJobIds: [jobB.id],
    });
    expect(svc.ok).toBe(false);
    if (!svc.ok) expect(svc.error.reason).toBe("dependency_cross_org");
  });

  it("(runtime) cannot alter the trigger, functions, or its own privileges; direct attempt mutation stays denied", { timeout: 30_000 }, async () => {
    const deny = (label: string, stmt: ReturnType<typeof runtimeSql.unsafe>) =>
      expect(stmt).rejects.toSatisfy((e: unknown) => pgCode(e) === "42501");
    await deny("drop trigger", runtimeSql.unsafe("drop trigger enforce_job_dependency_same_org on public.job_dependencies"));
    await deny("disable trigger", runtimeSql.unsafe("alter table public.job_dependencies disable trigger enforce_job_dependency_same_org"));
    await deny("replace trigger fn", runtimeSql.unsafe(
      "create or replace function public.enforce_job_dependency_same_org() returns trigger language plpgsql as $f$ begin return new; end $f$;",
    ));
    await deny("replace close fn", runtimeSql.unsafe(
      "create or replace function public.close_job_attempt(uuid,uuid,text,text,jsonb,uuid) returns void language plpgsql as $f$ begin return; end $f$;",
    ));
    await deny("drop close fn", runtimeSql.unsafe("drop function public.close_job_attempt(uuid,uuid,text,text,jsonb,uuid)"));
    // Self-grant is a PostgreSQL WARNING + no-op (runtime holds no grant
    // option on a table it does not own) — assert that NO privilege
    // materialized in the catalog afterwards.
    await runtimeSql.unsafe("grant update on public.job_attempts to stratifit_runtime");
    const grants = await runtimeSql`
      select string_agg(privilege_type, ',' order by privilege_type) as privs
      from information_schema.role_table_grants
      where grantee = 'stratifit_runtime' and table_schema = 'public' and table_name = 'job_attempts'`;
    expect(grants[0]!.privs).toBe("INSERT,SELECT");
    await deny("update attempt", runtimeSql.unsafe("update job_attempts set outcome = 'failed' where false"));
    await deny("delete attempt", runtimeSql.unsafe("delete from job_attempts where false"));
  });

  it("(runtime) definer functions enforce org/attempt consistency (consistency check only — tenant authorization is service-level by ratified Stage 2.7 architecture)", { timeout: 30_000 }, async () => {
    const jobA = await runtimeRepo.insertJob({
      orgId: orgA, jobType: "media.process", idempotencyKey: "rt-orgguard",
      subjectKind: "asset", subjectId: "0b8f9a6c-0000-4000-8000-000000000018",
      manifestRef: null, computeRequirementId: null, priority: 0, maxAttempts: 3,
    });
    const attempt = await runtimeRepo.insertJobAttempt({
      orgId: orgA, jobId: jobA.id, attemptNumber: 1, workerRef: "w-orgguard", allocationRef: null,
    });
    // org B presents ITS OWN org id with org A's attempt id — the definer
    // functions must refuse (org predicate in the WHERE clause).
    await expect(
      runtimeRepo.recordJobAttemptProgressScoped(orgB, attempt.id, { progress: 1 }),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "P0001");
    await expect(
      runtimeRepo.completeJobAttemptScoped(orgB, attempt.id, { outcome: "succeeded", errorDetail: null, progressSnapshot: {}, usageRecordId: null }),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "P0001");
    // The attempt is untouched.
    const after = await runtimeRepo.findJobAttemptById(attempt.id);
    expect(after?.completedAt).toBeNull();
    expect(after?.outcome).toBeNull();
  });

  it("(runtime) a failed definer call inside a transaction rolls the whole transaction back (no residue)", { timeout: 30_000 }, async () => {
    const jobA = await runtimeRepo.insertJob({
      orgId: orgA, jobType: "media.process", idempotencyKey: "rt-defroll",
      subjectKind: "asset", subjectId: "0b8f9a6c-0000-4000-8000-000000000019",
      manifestRef: null, computeRequirementId: null, priority: 0, maxAttempts: 3,
    });
    const attempt = await runtimeRepo.insertJobAttempt({
      orgId: orgA, jobId: jobA.id, attemptNumber: 1, workerRef: "w-defroll", allocationRef: null,
    });
    // Close it first so the in-transaction close below fails.
    await runtimeRepo.completeJobAttempt(attempt.id, { outcome: "failed", errorDetail: "first close", progressSnapshot: {}, usageRecordId: null });
    const jobsBefore = await runtimeSql`select count(*)::int as n from jobs where org_id = ${orgA} and idempotency_key like 'rt-defroll%'`;
    await expect(
      runtimeRepo.runInTransaction!(async (tx) => {
        await tx.insertJob({
          orgId: orgA, jobType: "media.process", idempotencyKey: "rt-defroll-2",
          subjectKind: "asset", subjectId: "0b8f9a6c-0000-4000-8000-00000000001a",
          manifestRef: null, computeRequirementId: null, priority: 0, maxAttempts: 3,
        });
        // Fails: the attempt is already closed → the WHOLE tx rolls back,
        // including the job insert above.
        await tx.completeJobAttempt(attempt.id, { outcome: "succeeded", errorDetail: null, progressSnapshot: {}, usageRecordId: null });
      }),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "P0001");
    const jobsAfter = await runtimeSql`select count(*)::int as n from jobs where org_id = ${orgA} and idempotency_key like 'rt-defroll%'`;
    expect(jobsAfter[0]!.n).toBe(jobsBefore[0]!.n); // insert rolled back with the failed close
  });

  afterAll(async () => {
    // Cleanup via the migrator role: remove the throwaway tenants in
    // FK-safe order. Test-only; never reachable from production runtime.
    await teardownTenants(["jobs-live-a", "jobs-live-b"]);
    await runtimeSql.end({ timeout: 1 });
    await sqlAdmin.end({ timeout: 1 });
  });
});
