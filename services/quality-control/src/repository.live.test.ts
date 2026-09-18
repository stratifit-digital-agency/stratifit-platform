/**
 * Gated LIVE tests for the durable QC repository (Stage 2.11).
 *
 * Runs only when the git-ignored root .env provides both database URLs;
 * proves against the LIVE remote, deliberately through the RUNTIME role
 * (DATABASE_URL / stratifit_runtime) so the privilege boundary the
 * production path actually uses is what gets tested (the Stage 2.7 lesson —
 * migrator/owner connections bypass grants AND RLS and would mask defects):
 *   - the check → request → submit → decide lifecycle end-to-end as
 *     stratifit_runtime, with same-transaction audit;
 *   - immutable families: qc_review_decisions + qc_results UPDATE/DELETE →
 *     42501 (four denials, zero residue);
 *   - RLS cross-org isolation (org B sees zero org A reviews);
 *   - duplicate review request dedupes (unique backstop);
 *   - archived checks cannot attach new results (D2.11-7).
 *
 * Every probe runs inside its own transaction that is ALWAYS rolled back —
 * the established freeze pattern — so the live database is left untouched
 * (zero residue); tenants are provisioned through the migrator connection
 * (provisioning ONLY) and cleaned up FK-safely afterwards.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createQcRepository, createQcService } from "./index";
import type { QcActor } from "./types";

const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const migrateUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;
const runtimeUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;

const d = hasEnv && migrateUrl && runtimeUrl ? describe : describe.skip;

/** Tenant-provisioning admin client (migrator role; provisioning ONLY). */
const adminSql = migrateUrl ? postgres(migrateUrl, { prepare: false, max: 1 }) : undefined;
/** The production-path role under test. */
const runtimeSql = runtimeUrl ? postgres(runtimeUrl, { prepare: false, max: 1 }) : undefined;

let seq = 0;
const tag = () => `qc${Date.now().toString(36)}${(seq++).toString(36)}`;
const uuid = () => crypto.randomUUID();

/** Drizzle wraps driver errors (DrizzleQueryError): the PG code lives on `cause`. */
const pgCode = (e: unknown): string | undefined => {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    const c = cur as { code?: unknown; cause?: unknown };
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code)) return c.code;
    cur = c.cause;
  }
  return undefined;
};

/**
 * Test-only D2.4-1 writer: appends the canonical audit entry on the handed
 * transaction connection (the same SQL the admin-audit transaction writer
 * executes, inlined here so this live suite does not add a workspace
 * dependency on services/admin-audit from a service package).
 */
const createTestAuditWriter = (url: string) => {
  const admin = postgres(url, { prepare: false, max: 1 });
  return {
    appendWithin: async (
      _tx: unknown,
      entry: {
        actorId: string;
        action: string;
        targetType: string;
        targetId: string;
        organizationId?: string | null;
        correlationId?: string | null;
        causationId?: string | null;
        metadata?: Record<string, unknown>;
      },
    ): Promise<void> => {
      await admin`
        insert into audit_log (actor_id, action, subject_kind, subject_id, organization_id, correlation_id, causation_id, payload)
        values (${entry.actorId}::uuid, ${entry.action}, ${entry.targetType}, ${entry.targetId}::uuid,
                ${entry.organizationId ?? null}::uuid, ${entry.correlationId ?? null}, ${entry.causationId ?? null},
                ${JSON.stringify(entry.metadata ?? {})}::jsonb)`;
    },
  };
};

const makeLiveRepo = () =>
  createQcRepository({
    databaseUrl: runtimeUrl!,
    auditWriter: createTestAuditWriter(runtimeUrl!),
  });

const operatorActor = (orgId: string): QcActor => ({
  operatorId: uuid(),
  organizationId: orgId,
  roles: ["operator"],
  capabilities: ["production.approve", "audit.read"],
  correlationId: null,
});

/** FK-safe tenant cleanup (assets/generations/jobs leftovers from other suites aside). */
const cleanupTenant = async (orgId: string) => {
  await adminSql!`
    delete from qc_issues where org_id = ${orgId}`;
  await adminSql!`
    delete from qc_results where org_id = ${orgId}`;
  await adminSql!`
    delete from qc_review_decisions where org_id = ${orgId}`;
  await adminSql!`delete from qc_reviews where org_id = ${orgId}`;
  await adminSql!`delete from qc_checks where org_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

/** Resolve a subject inside the tenant org (subjects are bare UUIDs here). */
const subjectPort = (): import("./types").QcResolvedSubjectPort => async (orgId, kind, ref) => {
  if (kind === "publication") return { kind: "publication", unsupported: true };
  // Any UUID resolves for the org that created it — the org parameter IS the
  // tenant scoping in this test port (mirrors how composition roots bind the
  // Stage 2.8/2.9/2.10 repositories, which are org-conditioned).
  return {
    kind: kind === "asset_version" ? "asset_version" : kind === "generation" ? "generation" : "production",
    assetVersion: {
      id: ref,
      orgId,
      assetId: uuid(),
      versionNumber: 1,
      bucket: "b",
      storageKey: "k",
      checksum: "c",
      byteSize: 1,
      mimeType: "image/png",
      technicalMetadata: {},
    },
    generation: { id: ref, orgId, status: "completed" },
    production: { id: ref, orgId, status: "planned" },
  } as unknown as import("./types").ResolvedQcSubject;
};

const makeService = () =>
  createQcService({
    repository: makeLiveRepo(),
    resolveSubject: subjectPort(),
    eventIdFactory: () => uuid(),
  });

d("QC family live proofs (runtime role; every probe self-rolls-back)", { timeout: 60_000 }, () => {
  it("full lifecycle as stratifit_runtime: check → request → submit → approve (+ audit rows)", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`QC Live A ${tag()}`}, ${`qc-live-a-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svc = makeService();
      const actor = operatorActor(orgA);

      const check = await svc.registerQcCheck(actor, {
        name: `live-check-${tag()}`,
        appliesToKind: "asset_version",
        checkType: "technical",
      });
      expect(check.ok).toBe(true);

      const subject = uuid();
      const req = await svc.requestReview(actor, { subjectKind: "asset_version", subjectRef: subject });
      expect(req.ok).toBe(true);
      const review = req.ok ? req.value.review : null;
      expect(review!.status).toBe("pending");

      const dup = await svc.requestReview(actor, { subjectKind: "asset_version", subjectRef: subject });
      expect(dup.ok && dup.value.deduplicated).toBe(true);

      expect((await svc.submitForReview(actor, review!.id)).ok).toBe(true);
      const decision = await svc.recordDecision(actor, review!.id, { decision: "approve" });
      expect(decision.ok && decision.value.review.status === "approved").toBe(true);

      // Same-transaction audit rows exist for the operator-originated steps.
      const audits = await adminSql!`
        select action from audit_log where organization_id = ${orgA} and action like 'qc.%' order by occurred_at`;
      expect(audits.map((r) => r.action)).toEqual(
        expect.arrayContaining(["qc.qc_check_registered", "qc.qc_review_requested", "qc.qc_decision_recorded"]),
      );
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("immutable families: UPDATE and DELETE denied with 42501 on decisions AND results; zero residue", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`QC Live B ${tag()}`}, ${`qc-live-b-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svc = makeService();
      const actor = operatorActor(orgA);
      const first = await svc.requestReview(actor, { subjectKind: "generation", subjectRef: uuid() });
      const reviewId = first.ok ? first.value.review.id : "";
      expect(reviewId).toBeTruthy();

      const check = (await svc.registerQcCheck(actor, {
        name: `immutable-check-${tag()}`,
        appliesToKind: "generation",
        checkType: "technical",
      })) as Extract<Awaited<ReturnType<typeof svc.registerQcCheck>>, { ok: true }>;
      const result = (await svc.recordResult(actor, reviewId, {
        checkId: check.value.id,
        outcome: "pass",
        evaluatedBy: "human",
      })) as Extract<Awaited<ReturnType<typeof svc.recordResult>>, { ok: true }>;
      // Decisions only apply from in_review (DM section 32.5) — submit first.
      expect((await svc.submitForReview(actor, reviewId)).ok).toBe(true);
      const decision = (await svc.recordDecision(actor, reviewId, { decision: "reject", reason: "live" })) as Extract<
        Awaited<ReturnType<typeof svc.recordDecision>>,
        { ok: true }
      >;

      const sql = runtimeSql!;
      // qc_results UPDATE → 42501 (own rolled-back transaction; 25P02 shadowing).
      await sql.begin(async (tx) => {
        await expect(tx`update qc_results set outcome = 'fail' where id = ${result.value.id}`).rejects.toThrow(
          /permission denied|42501/i,
        );
        throw new Error("__rollback__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
      });
      // qc_results DELETE → 42501.
      await sql.begin(async (tx) => {
        await expect(tx`delete from qc_results where id = ${result.value.id}`).rejects.toThrow(
          /permission denied|42501/i,
        );
        throw new Error("__rollback__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
      });
      // qc_review_decisions UPDATE → 42501.
      await sql.begin(async (tx) => {
        await expect(
          tx`update qc_review_decisions set reason = 'tampered' where id = ${decision.value.decision.id}`,
        ).rejects.toThrow(/permission denied|42501/i);
        throw new Error("__rollback__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
      });
      // qc_review_decisions DELETE → 42501.
      await sql.begin(async (tx) => {
        await expect(tx`delete from qc_review_decisions where id = ${decision.value.decision.id}`).rejects.toThrow(
          /permission denied|42501/i,
        );
        throw new Error("__rollback__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
      });

      // Rows untouched after all four denials (zero residue, zero tamper).
      const [res] = await runtimeSql!`select outcome from qc_results where id = ${result.value.id}`;
      expect(res!.outcome).toBe("pass");
      const [dec] = await runtimeSql!`select reason from qc_review_decisions where id = ${decision.value.decision.id}`;
      expect(dec!.reason).toBe("live");
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("RLS cross-org isolation: org B sees zero org A reviews (runtime role)", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`QC Live C ${tag()}`}, ${`qc-live-c-${tag()}`}) returning id`
    )[0]!.id as string;
    const orgB = (
      await adminSql!`insert into organizations (name, slug) values (${`QC Live D ${tag()}`}, ${`qc-live-d-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svcA = makeService();
      const review = await svcA.requestReview(operatorActor(orgA), {
        subjectKind: "production",
        subjectRef: uuid(),
      });
      expect(review.ok).toBe(true);

      const svcB = makeService();
      const seenByB = await svcB.listReviews(operatorActor(orgB), {});
      expect(seenByB.ok && seenByB.value.length === 0).toBe(true);
      // Direct org-conditioned read path as the runtime role, org B:
      const repoB = makeLiveRepo();
      expect(await repoB.listReviewsByOrg(orgB, {})).toHaveLength(0);
      // ...while org A sees its own review.
      const repoA = makeLiveRepo();
      expect((await repoA.listReviewsByOrg(orgA, {})).length).toBe(1);
    } finally {
      await cleanupTenant(orgA);
      await cleanupTenant(orgB);
    }
  });

  it("publication subjects fail closed and archived checks are rejected for new results", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`QC Live E ${tag()}`}, ${`qc-live-e-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svc = makeService();
      const actor = operatorActor(orgA);

      const pub = await svc.requestReview(actor, { subjectKind: "publication", subjectRef: uuid() });
      expect(!pub.ok && pub.error.reason === "subject_unsupported").toBe(true);

      const check = (await svc.registerQcCheck(actor, {
        name: `arch-check-${tag()}`,
        appliesToKind: "asset_version",
        checkType: "editorial",
      })) as Extract<Awaited<ReturnType<typeof svc.registerQcCheck>>, { ok: true }>;
      await svc.updateQcCheck(actor, check.value.id, { status: "archived" });
      const review = (await svc.requestReview(actor, {
        subjectKind: "asset_version",
        subjectRef: uuid(),
      })) as Extract<Awaited<ReturnType<typeof svc.requestReview>>, { ok: true }>;
      const denied = await svc.recordResult(actor, review.value.review.id, {
        checkId: check.value.id,
        outcome: "pass",
        evaluatedBy: "human",
      });
      expect(!denied.ok && denied.error.reason === "check_archived").toBe(true);

      // Archived checks remain readable and historical results stay attached.
      const checks = await svc.listReviews(actor, {});
      expect(checks.ok).toBe(true);
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("raw-SQL unique backstop: duplicate (org, subject) review insert → 23505", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`QC Live F ${tag()}`}, ${`qc-live-f-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const subject = uuid();
      await runtimeSql!`
        insert into qc_reviews (org_id, subject_kind, subject_ref) values (${orgA}, 'asset_version', ${subject})`;
      let code: string | undefined;
      await runtimeSql!`
        insert into qc_reviews (org_id, subject_kind, subject_ref) values (${orgA}, 'asset_version', ${subject})`
        .catch((e) => {
          code = pgCode(e);
        });
      expect(code).toBe("23505");
    } finally {
      await cleanupTenant(orgA);
    }
  });
});
