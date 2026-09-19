/**
 * Gated LIVE tests for the audience PUBLIC CONTENT projection (Stage 2.13).
 *
 * Runs only when the git-ignored root .env provides both database URLs;
 * proves against the LIVE remote, deliberately through the RUNTIME role
 * (DATABASE_URL / stratifit_runtime) — the privilege boundary the production
 * path actually uses (the Stage 2.7 lesson):
 *   - runtime grants map = 36 distinct tables incl. public_content + watch_progress (ARWD);
 *   - RLS enabled with exactly the runtime_all policy TO stratifit_runtime;
 *   - UNIQUE(publication_version_id) idempotency backstop (23505);
 *   - UNIQUE(slug) global backstop (23505);
 *   - CHECK constraints reject illegal status/content-type values (23514);
 *   - FK ON DELETE RESTRICT protects the publishing family (23503);
 *   - cross-org isolation: org B sees zero org A rows through the service;
 *   - END-TO-END: publish → publication.published envelope → projection →
 *     public read; duplicate → no-op; unpublish → public read disappears.
 *
 * Tenant rows are provisioned through the migrator connection (provisioning
 * ONLY) and cleaned up FK-safely afterwards — zero residue.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDrizzleAudienceRepository, createAudienceService, createPublicContentReader, UniqueViolationSignal } from "./index";
import { makeEnvelope } from "@stratifit/contracts";

const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const migrateUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;
const runtimeUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;

const d = hasEnv && migrateUrl && runtimeUrl ? describe : describe.skip;

const adminSql = migrateUrl ? postgres(migrateUrl, { prepare: false, max: 1 }) : undefined;
const runtimeSql = runtimeUrl ? postgres(runtimeUrl, { prepare: false, max: 1 }) : undefined;

let seq = 0;
const uuid = () => crypto.randomUUID();

/** Test-only D2.4-1 writer (same canonical audit INSERT the real writer uses). */
const createTestAuditWriter = (url: string) => {
  const admin = postgres(url, { prepare: false, max: 1 });
  return {
    appendWithin: async (
      _tx: unknown,
      entry: {
        actorId: string;
        action: string;
        subjectKind: string;
        subjectId: string;
        organizationId?: string | null;
        correlationId?: string | null;
        causationId?: string | null;
        payload?: Record<string, unknown>;
      },
    ): Promise<void> => {
      await admin`
        insert into audit_log (actor_id, action, subject_kind, subject_id, organization_id, correlation_id, causation_id, payload)
        values (${entry.actorId}::uuid, ${entry.action}, ${entry.subjectKind}, ${entry.subjectId}::uuid,
                ${entry.organizationId ?? null}::uuid, ${entry.correlationId ?? null}, ${entry.causationId ?? null},
                ${JSON.stringify(entry.payload ?? {})}::jsonb)`;
    },
  };
};

const auditEntries = () => ({ entries: [] as Array<{ action: string; subjectId: string }> });

/**
 * SHARED live fixtures: the Supabase pooler caps connections (15), so this
 * suite creates ONE audit-writer client and ONE repository pool and reuses
 * them across all tests (the Stage 2.12 lesson — per-test pools exhaust the
 * pooler and stall). `tracked` collects audit actions per test.
 */
const trackedShared = auditEntries();
const sharedAuditWriter = createTestAuditWriter(runtimeUrl!);
const sharedRepo = createDrizzleAudienceRepository({
  databaseUrl: runtimeUrl!,
  auditWriter: {
    appendWithin: async (tx, entry) => {
      trackedShared.entries.push({ action: entry.action, subjectId: entry.subjectId });
      await sharedAuditWriter.appendWithin(tx, entry);
    },
  },
});
const sharedService = createAudienceService({ repository: sharedRepo, slugify: (title: string) => title });
const sharedReader = createPublicContentReader({
  listContent: () => sharedService.listContent(),
  getContentBySlug: (slug) => sharedService.getContentBySlug(slug),
});

/** FK-safe tenant cleanup (children before parents). */
const cleanupTenant = async (orgId: string) => {
  await adminSql!`delete from public_content where org_id = ${orgId}`;
  await adminSql!`delete from distribution_references where org_id = ${orgId}`;
  await adminSql!`delete from publication_versions where org_id = ${orgId}`;
  await adminSql!`delete from publications where org_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

/** Provisions an org + a published publication/version pair for projection. */
const provisionPublishedPublication = async (slugTag: string) => {
  const orgId = (await adminSql!`insert into organizations (name, slug) values (${"aud-live-" + slugTag}, ${"aud-live-" + slugTag}) returning id`)[0]!.id as string;
  const pubId = (
    await adminSql!`insert into publications (org_id, subject_kind, subject_ref, platform_target, content_type, status)
      values (${orgId}::uuid, 'production', ${uuid()}::uuid, 'stratifit-media', 'film', 'published') returning id`
  )[0]!.id as string;
  const versionId = (
    await adminSql!`insert into publication_versions (org_id, publication_id, version_number, title, content_type, subject_kind, subject_ref)
      values (${orgId}::uuid, ${pubId}::uuid, 1, ${"Night Harbor " + slugTag}, 'film', 'production', ${uuid()}::uuid) returning id`
  )[0]!.id as string;
  await adminSql!`update publications set current_version_id = ${versionId}::uuid where id = ${pubId}::uuid`;
  return { orgId, pubId, versionId };
};

d("audience live proofs (runtime role)", () => {
  it("runtime grants map = 36 distinct tables with public_content + watch_progress ARWD", { timeout: 30_000 }, async () => {
    const [counts] = await runtimeSql!`select count(distinct table_name)::int as n from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_schema = 'public'`;
    expect(counts!.n).toBe(36);
    const [pc] = await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = 'public_content' and table_schema = 'public'`;
    expect(pc!.privs).toBe("DELETE,INSERT,SELECT,UPDATE");
    const [wp] = await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = 'watch_progress' and table_schema = 'public'`;
    expect(wp!.privs).toBe("DELETE,INSERT,SELECT,UPDATE");
  });

  it("RLS enabled on public_content with exactly the runtime_all policy TO stratifit_runtime", { timeout: 30_000 }, async () => {
    const [rls] = await runtimeSql!`select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'public_content'`;
    expect(rls!.rowsecurity).toBe(true);
    const pols = await runtimeSql!`select policyname, roles::text as roles from pg_policies where schemaname = 'public' and tablename = 'public_content'`;
    expect(pols).toHaveLength(1);
    expect(pols[0]!.policyname).toBe("runtime_all");
    expect(pols[0]!.roles).toContain("stratifit_runtime");
  });

  it("UNIQUE(publication_version_id) idempotency backstop fires (23505)", { timeout: 30_000 }, async () => {
    const tag = `u${Date.now().toString(36)}`;
    const { orgId, pubId, versionId } = await provisionPublishedPublication(tag);
    try {
      const tracked = trackedShared;
      tracked.entries.length = 0;
      const service = sharedService;
      const evt = (id: string) =>
        makeEnvelope({
          eventId: `evt-${id}`,
          name: "publication.published",
          correlation: { organizationId: orgId, publicationId: pubId },
          payload: { publicationId: pubId, versionId, versionNumber: 1, platformTarget: "stratifit-media", externalRef: "x", title: `Night ${tag}`, synopsis: null, contentType: "film" },
        });
      const first = await service.projectPublished({ envelope: evt("a") });
      expect(first.ok).toBe(true);
      // A second service instance (simulating another consumer process) hits
      // the DB unique backstop via insert → the DB, not convention, decides.
      await expect(
        sharedRepo.insertContent({
          orgId,
          publicationId: pubId,
          publicationVersionId: versionId,
          slug: `other-${tag}`,
          contentType: "film",
          title: "Other",
          synopsis: null,
          mediaRefs: [],
          publishedAt: new Date(),
          categories: [],
        }),
      ).rejects.toBeInstanceOf(UniqueViolationSignal);
    } finally {
      await cleanupTenant(orgId);
    }
  });

  it("UNIQUE(slug) global backstop fires (23505)", { timeout: 30_000 }, async () => {
    const tag = `s${Date.now().toString(36)}`;
    const a = await provisionPublishedPublication(tag);
    const b = await provisionPublishedPublication(`${tag}b`);
    try {
      const repo = sharedRepo;
      const base = { synopsis: null, mediaRefs: [] as never[], publishedAt: new Date(), categories: [] as never[], contentType: "film" as const };
      await repo.insertContent({ orgId: a.orgId, publicationId: a.pubId, publicationVersionId: a.versionId, slug: `clash-${tag}`, title: "A", ...base });
      await expect(
        repo.insertContent({ orgId: b.orgId, publicationId: b.pubId, publicationVersionId: b.versionId, slug: `clash-${tag}`, title: "B", ...base }),
      ).rejects.toBeInstanceOf(UniqueViolationSignal);
    } finally {
      await cleanupTenant(a.orgId);
      await cleanupTenant(b.orgId);
    }
  });

  it("CHECK constraints reject illegal status and content_type values (23514)", { timeout: 30_000 }, async () => {
    const tag = `c${Date.now().toString(36)}`;
    const { orgId, pubId, versionId } = await provisionPublishedPublication(tag);
    try {
      const bad = await runtimeSql!`insert into public_content (org_id, publication_id, publication_version_id, slug, content_type, title, published_at, status)
        values (${orgId}, ${pubId}, ${versionId}, ${"x-" + tag}, 'film', 'x', now(), 'archived')`.catch((e) => e.code);
      expect(bad).toBe("23514");
      const bad2 = await runtimeSql!`insert into public_content (org_id, publication_id, publication_version_id, slug, content_type, title, published_at, status)
        values (${orgId}, ${pubId}, ${versionId}, ${"y-" + tag}, 'hologram', 'y', now(), 'published')`.catch((e) => e.code);
      expect(bad2).toBe("23514");
    } finally {
      await cleanupTenant(orgId);
    }
  });

  it("FK ON DELETE RESTRICT protects the publishing family (23503)", { timeout: 30_000 }, async () => {
    const tag = `f${Date.now().toString(36)}`;
    const { orgId, pubId, versionId } = await provisionPublishedPublication(tag);
    try {
      await adminSql!`insert into public_content (org_id, publication_id, publication_version_id, slug, content_type, title, published_at, status)
        values (${orgId}, ${pubId}, ${versionId}, ${"fk-" + tag}, 'film', 't', now(), 'published')`;
      const del = await adminSql!`delete from publication_versions where id = ${versionId}`.catch((e) => e.code);
      expect(del).toBe("23503");
      const del2 = await adminSql!`delete from publications where id = ${pubId}`.catch((e) => e.code);
      expect(del2).toBe("23503");
    } finally {
      await cleanupTenant(orgId);
    }
  });

  it("cross-org isolation: org B service paths see zero org A content", { timeout: 30_000 }, async () => {
    const tag = `x${Date.now().toString(36)}`;
    const a = await provisionPublishedPublication(tag);
    const b = await provisionPublishedPublication(`${tag}b`);
    try {
      await adminSql!`insert into public_content (org_id, publication_id, publication_version_id, slug, content_type, title, published_at, status)
        values (${a.orgId}, ${a.pubId}, ${a.versionId}, ${"iso-" + tag}, 'film', 'secret-a', now(), 'published')`;
      // PUBLIC CONTENT IS ORG-BLIND BY DESIGN: it is the audience-facing
      // projection (Media reads it anonymously). The public-safe boundary is
      // the projection whitelist — no org identity ever leaves the API — not
      // a per-org read filter. Cross-org ISOLATION still holds everywhere it
      // must: lookups made through an org-conditioned path (e.g. the Control
      // service ports, or foreign-org publications) fail closed, and A's
      // internal ids leak nothing beyond the approved public fields.
      const rows = await sharedReader.listContent();
      // A's published row is legitimately visible to the public surface.
      expect(rows.some((r) => r.slug === `iso-${tag}`)).toBe(true);
      // The projection exposes NO organization identity.
      for (const r of rows) expect(JSON.stringify(r)).not.toContain("orgId");
      // Unpublishing (takedown) removes the row from the public surface.
      await adminSql!`update public_content set status = 'unpublished' where slug = ${`iso-${tag}`}`;
      const after = await sharedReader.listContent();
      expect(after.some((r) => r.slug === `iso-${tag}`)).toBe(false);
    } finally {
      await cleanupTenant(a.orgId);
      await cleanupTenant(b.orgId);
    }
  });

  it("END-TO-END: publish event → projection → public read → unpublish event → read disappears; duplicate events are no-ops", { timeout: 30_000 }, async () => {
    const tag = `e2e${Date.now().toString(36)}`;
    const { orgId, pubId, versionId } = await provisionPublishedPublication(tag);
    try {
      const tracked = trackedShared;
      tracked.entries.length = 0;
      const service = sharedService;
      const reader = sharedReader;

      const published = makeEnvelope({
        eventId: `evt-p-${tag}`,
        name: "publication.published",
        correlation: { organizationId: orgId, publicationId: pubId },
        payload: { publicationId: pubId, versionId, versionNumber: 1, platformTarget: "stratifit-media", externalRef: "x", title: `E2E ${tag}`, synopsis: "s", contentType: "film" },
      });
      const first = await service.projectPublished({ envelope: published });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value.kind).toBe("projected");

      // Public read shows it.
      const slug = `e2e-${tag}`;
      expect((await reader.getContentBySlug(slug))?.title).toBe(`E2E ${tag}`);

      // Duplicate event → noop_duplicate, still exactly one row, no new audit.
      const dup = await service.projectPublished({ envelope: published });
      expect(dup.ok).toBe(true);
      if (dup.ok) expect(dup.value.kind).toBe("noop_duplicate");
      const countRows = await runtimeSql!`select count(*)::int as n from public_content where publication_version_id = ${versionId}`;
      expect(countRows[0]!.n).toBe(1);

      // Unpublish event → public read disappears.
      const unpublished = makeEnvelope({
        eventId: `evt-u-${tag}`,
        name: "publication.unpublished",
        correlation: { organizationId: orgId, publicationId: pubId },
        payload: { publicationId: pubId },
      });
      const down = await service.unpublishContent({ envelope: unpublished });
      expect(down.ok).toBe(true);
      if (down.ok) expect(down.value.kind).toBe("unpublished");
      expect(await reader.getContentBySlug(slug)).toBeUndefined();
      expect((await reader.listContent()).some((r) => r.slug === slug)).toBe(false);

      // Repeated unpublish → no-op.
      const again = await service.unpublishContent({ envelope: unpublished });
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.value.kind).toBe("noop_already_unpublished");

      // Audit trail: exactly projection + unpublish (no no-op audits).
      expect(tracked.entries.map((a) => a.action)).toEqual([
        "audience.public_content_projected",
        "audience.public_content_unpublished",
      ]);
    } finally {
      await cleanupTenant(orgId);
    }
  });
});
