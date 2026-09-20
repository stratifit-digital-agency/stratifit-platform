/**
 * Gated LIVE tests for the durable publishing repository and reader
 * (Stage 2.12).
 *
 * Runs only when the git-ignored root .env provides both database URLs;
 * proves against the LIVE remote, deliberately through the RUNTIME role
 * (DATABASE_URL / stratifit_runtime) so the privilege boundary the
 * production path actually uses is what gets tested (the Stage 2.7 lesson —
 * migrator/owner connections bypass grants AND RLS and would mask defects):
 *   - the create → submit → approve → schedule → publish lifecycle
 *     end-to-end as stratifit_runtime, with same-transaction audit;
 *   - immutable families: publication_versions + distribution_references
 *     UPDATE/DELETE → 42501 (four denials, zero residue);
 *   - RLS cross-org isolation (org B sees zero org A publications);
 *   - fail-closed subjects (ai_creator_profile → subject_unsupported);
 *   - the durable PublicationReader returns ONLY published rows.
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
import { createDrizzlePublishingRepository, createPublishingService, DurablePublicationReader, DurableStratifitMediaAdapter } from "./index";
import type { PublicationActor, PublishingRepository } from "./types";

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
const tag = () => `pub${Date.now().toString(36)}${(seq++).toString(36)}`;
const uuid = () => crypto.randomUUID();

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

const makeLiveRepo = (): PublishingRepository =>
  createDrizzlePublishingRepository({
    databaseUrl: runtimeUrl!,
    auditWriter: createTestAuditWriter(runtimeUrl!),
  });

const operatorActor = (orgId: string): PublicationActor => ({
  operatorId: uuid(),
  organizationId: orgId,
  roles: ["operator"],
  capabilities: ["production.publish", "audit.read"],
  correlationId: null,
});

/** Resolve a subject inside the tenant org (subjects are bare UUIDs here).
 * Stage 2.16: ai_creator_profile remains FAIL-CLOSED here (no People rows are
 * provisioned in this suite), matching the campaign_creative unsupported arm. */
const subjectPort = () => async (orgId: string, kind: string, ref: string) => {
  if (kind === "campaign_creative") {
    return { kind, unsupported: true } as const;
  }
  if (kind === "ai_creator_profile") {
    return null; // no durable People subject in this suite → fail closed
  }
  return { kind: kind as "production" | "asset_version", orgId, ref };
};

const makeService = () =>
  createPublishingService({
    repository: makeLiveRepo(),
    resolveSubject: subjectPort(),
    resolveEligibility: async () => ({ eligible: true, reasons: [] }),
    // D2.12-A: rights port UNWIRED (absent = vacuous pass).
    adapters: [new DurableStratifitMediaAdapter()],
  });

/** FK-safe tenant cleanup (children before parents). */
const cleanupTenant = async (orgId: string) => {
  await adminSql!`delete from distribution_references where org_id = ${orgId}`;
  await adminSql!`delete from publication_versions where org_id = ${orgId}`;
  await adminSql!`delete from publications where org_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

/** Drives a publication from draft to scheduled through legal edges. */
const prepareScheduled = async (svc: ReturnType<typeof makeService>, actor: PublicationActor) => {
  const created = await svc.createPublication(actor, {
    subjectKind: "production",
    subjectRef: uuid(),
    platformTarget: "stratifit-media",
    contentType: "film",
    title: `Live Premiere ${tag()}`,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  const id = created.value.publication.id;
  expect((await svc.submit(actor, id)).ok).toBe(true);
  expect((await svc.approve(actor, id)).ok).toBe(true);
  const scheduled = await svc.schedule(actor, id, {
    scheduledFor: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(scheduled.ok).toBe(true);
  return created.value;
};

d("Publishing family live proofs (runtime role; every probe self-rolls-back)", { timeout: 90_000 }, () => {
  it("full lifecycle as stratifit_runtime: create → v1 → submit → approve → schedule → publish (+ audit rows)", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`PUB Live A ${tag()}`}, ${`pub-live-a-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svc = makeService();
      const actor = operatorActor(orgA);

      const created = await svc.createPublication(actor, {
        subjectKind: "asset_version",
        subjectRef: uuid(),
        platformTarget: "stratifit-media",
        contentType: "trailer",
        title: "Live Trailer",
        synopsis: "Published from the live suite",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.version.versionNumber).toBe(1);
      // FROZEN version shape on the live row: subject carried, no qc_review_id.
      expect(created.value.version.subjectRef).toBe(created.value.publication.subjectRef);
      const pubId = created.value.publication.id;

      // FROZEN: a duplicate (org, subject, platform) is a deterministic
      // publication_conflict (the UNIQUE constraint is the backstop).
      const dup = await svc.createPublication(actor, {
        subjectKind: "asset_version",
        subjectRef: created.value.publication.subjectRef,
        platformTarget: "stratifit-media",
        contentType: "trailer",
        title: "Live Trailer",
      });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.error.reason).toBe("publication_conflict");

      expect((await svc.submit(actor, pubId)).ok).toBe(true);
      expect((await svc.approve(actor, pubId)).ok).toBe(true);
      expect(
        (await svc.schedule(actor, pubId, { scheduledFor: new Date(Date.now() + 60_000).toISOString() })).ok,
      ).toBe(true);
      const published = await svc.publish(actor, pubId);
      expect(published.ok).toBe(true);
      if (published.ok) {
        expect(published.value.publication.status).toBe("published");
        expect(published.value.reference.deliveryOutcome).toBe("delivered");
        expect(published.value.reference.externalRef).toBeTruthy();
        // The approval-time QC reference is stamped on the PUBLICATION.
        expect(published.value.publication).toHaveProperty("qcReviewId");
      }

      // Same-transaction audit rows exist for the operator-originated steps.
      const audits = await adminSql!`
        select action from audit_log where organization_id = ${orgA} and action like 'publishing.%' order by occurred_at`;
      expect(audits.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          "publishing.publication_created",
          "publishing.publication_approved",
          "publishing.publication_scheduled",
          "publishing.publication_published",
        ]),
      );
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("immutable families: UPDATE and DELETE denied with 42501 on versions AND distribution references; zero residue", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`PUB Live B ${tag()}`}, ${`pub-live-b-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svc = makeService();
      const actor = operatorActor(orgA);
      const prepared = await prepareScheduled(svc, actor);
      const pubId = prepared.publication.id;
      const published = (await svc.publish(actor, pubId)) as Extract<
        Awaited<ReturnType<typeof svc.publish>>,
        { ok: true }
      >;
      const versionId = published.value.publication.currentVersionId!;
      const refId = published.value.reference.id;

      const sql = runtimeSql!;
      // publication_versions UPDATE → 42501 (own rolled-back transaction).
      await sql.begin(async (tx) => {
        await expect(
          tx`update publication_versions set title = 'tampered' where id = ${versionId}`,
        ).rejects.toThrow(/permission denied|42501/i);
        throw new Error("__rollback__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
      });
      // publication_versions DELETE → 42501.
      await sql.begin(async (tx) => {
        await expect(tx`delete from publication_versions where id = ${versionId}`).rejects.toThrow(
          /permission denied|42501/i,
        );
        throw new Error("__rollback__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
      });
      // distribution_references UPDATE → 42501.
      await sql.begin(async (tx) => {
        await expect(
          tx`update distribution_references set external_ref = 'tampered' where id = ${refId}`,
        ).rejects.toThrow(/permission denied|42501/i);
        throw new Error("__rollback__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
      });
      // distribution_references DELETE → 42501.
      await sql.begin(async (tx) => {
        await expect(tx`delete from distribution_references where id = ${refId}`).rejects.toThrow(
          /permission denied|42501/i,
        );
        throw new Error("__rollback__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
      });

      // Rows untouched after all four denials (zero residue, zero tamper).
      const [v] = await runtimeSql!`select title from publication_versions where id = ${versionId}`;
      expect(v!.title).not.toBe("tampered");
      const [r] = await runtimeSql!`select external_ref from distribution_references where id = ${refId}`;
      expect(r!.external_ref).not.toBe("tampered");
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("RLS cross-org isolation: org B sees zero org A publications (runtime role)", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`PUB Live C ${tag()}`}, ${`pub-live-c-${tag()}`}) returning id`
    )[0]!.id as string;
    const orgB = (
      await adminSql!`insert into organizations (name, slug) values (${`PUB Live D ${tag()}`}, ${`pub-live-d-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svcA = makeService();
      const created = await svcA.createPublication(operatorActor(orgA), {
        subjectKind: "production",
        subjectRef: uuid(),
        platformTarget: "stratifit-media",
        contentType: "film",
        title: "Org A Secret Cut",
      });
      expect(created.ok).toBe(true);

      // Org-conditioned read path as the runtime role: org B sees nothing.
      const repoB = makeLiveRepo();
      expect(await repoB.listVersions(orgB, (created as { ok: true; value: { publication: { id: string } } }).value.publication.id)).toHaveLength(0);
      const foreign = await svcA.getPublication(operatorActor(orgB), (created as { ok: true; value: { publication: { id: string } } }).value.publication.id);
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.error.reason).toBe("publication_not_found");
    } finally {
      await cleanupTenant(orgA);
      await cleanupTenant(orgB);
    }
  });

  it("fail-closed subjects: ai_creator_profile with no durable People subject → subject_not_found (D2.12-D + Stage 2.16 D2.16-6)", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`PUB Live E ${tag()}`}, ${`pub-live-e-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svc = makeService();
      // Stage 2.16: ai_creator_profile resolves through the narrow People
      // subject port — with NO active AI creator + profile in this tenant it
      // fails CLOSED (subject_not_found, IDOR-safe, no existence leak).
      const result = await svc.createPublication(operatorActor(orgA), {
        subjectKind: "ai_creator_profile",
        subjectRef: uuid(),
        platformTarget: "stratifit-media",
        contentType: "series",
        title: "No Creator Contexts Yet",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe("subject_not_found");
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("durable PublicationReader: ONLY published rows are visible; unpublished/draft invisible", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`PUB Live F ${tag()}`}, ${`pub-live-f-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      const svc = makeService();
      const actor = operatorActor(orgA);
      const reader = new DurablePublicationReader({ databaseUrl: runtimeUrl! });

      // A draft publication must be invisible.
      const draft = await svc.createPublication(actor, {
        subjectKind: "production",
        subjectRef: uuid(),
        platformTarget: "stratifit-media",
        contentType: "short",
        title: "Still Draft",
      });
      expect(draft.ok).toBe(true);
      const draftId = (draft as { ok: true; value: { publication: { id: string } } }).value.publication.id;
      expect(await reader.get(draftId)).toBeUndefined();

      // Publish one and it becomes visible through the durable reader.
      const prepared = await prepareScheduled(svc, actor);
      expect((await svc.publish(actor, prepared.publication.id)).ok).toBe(true);
      const visible = await reader.get(prepared.publication.id);
      expect(visible).toBeDefined();
      expect(visible!.status).toBe("published");
      expect(visible!.title).toBe(prepared.version!.title);
      expect(visible!.target).toBe("stratifit-media");
      // Public-safe projection: contentRef is the OPAQUE publication id.
      expect(visible!.contentRef).toBe(prepared.publication.id);
      const listed = await reader.listPublished("stratifit-media");
      expect(listed.some((r) => r.publicationId === prepared.publication.id)).toBe(true);
      expect(listed.some((r) => r.publicationId === draftId)).toBe(false);

      // After unpublish, the reader hides it again.
      expect((await svc.unpublish(actor, prepared.publication.id)).ok).toBe(true);
      expect(await reader.get(prepared.publication.id)).toBeUndefined();
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("CHECK constraint backstop: an illegal status value is rejected at the database", async () => {
    const orgA = (
      await adminSql!`insert into organizations (name, slug) values (${`PUB Live G ${tag()}`}, ${`pub-live-g-${tag()}`}) returning id`
    )[0]!.id as string;
    try {
      await expect(
        runtimeSql!`insert into publications (org_id, subject_kind, subject_ref, platform_target, content_type, status)
          values (${orgA}, 'production', ${uuid()}, 'stratifit-media', 'film', 'flying')`,
      ).rejects.toThrow(/publications_status_check|check constraint/i);
    } finally {
      await cleanupTenant(orgA);
    }
  });
});
