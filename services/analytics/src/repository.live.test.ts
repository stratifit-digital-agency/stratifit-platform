/**
 * Gated LIVE tests for the ANALYTICS INTAKE family (Stage 2.19).
 *
 * Runs only when the git-ignored root .env provides both database URLs.
 * Proves against the LIVE remote through the RUNTIME role (DATABASE_URL /
 * stratifit_runtime) — the privilege boundary production uses:
 *   - runtime grants map = 54 distinct tables incl. analytics_events with
 *     INSERT+SELECT only (immutable intake family);
 *   - RLS enabled with exactly the runtime_all policy TO stratifit_runtime;
 *   - UPDATE/DELETE on analytics_events are permission-denied (42501) and
 *     rows remain unchanged;
 *   - eventType CHECK + 64-hex session_hash CHECK (23514);
 *   - UNIQUE(ingest_event_id) dedupe (23505 / onConflictDoNothing);
 *   - FK ON DELETE RESTRICT protection (23503);
 *   - Case E end-to-end through the REAL service+repository: published-only
 *     server-side resolution, anonymous acceptance, idempotent replay,
 *     unknown content fail-closed.
 *
 * Tenant rows are provisioned through the migrator connection (provisioning
 * ONLY) and cleaned up FK-safely afterwards — zero residue.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  createAnalyticsService,
  createDrizzleAnalyticsRepository,
  hashSessionId,
} from "./index";

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

const uuid = () => crypto.randomUUID();

let repo: ReturnType<typeof createDrizzleAnalyticsRepository> | undefined;

beforeAll(() => {
  if (runtimeUrl) repo = createDrizzleAnalyticsRepository({ databaseUrl: runtimeUrl });
});

/** FK-safe tenant wipe (provisioned rows only). */
const wipeTenant = async (orgId: string) => {
  await adminSql!`delete from analytics_events where org_id = ${orgId}`;
  await adminSql!`delete from public_content where org_id = ${orgId}`;
  await adminSql!`delete from publication_versions where org_id = ${orgId}`;
  await adminSql!`delete from publications where org_id = ${orgId}`;
  await adminSql!`delete from audience_users where org_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

/** Orphan scrub from interrupted prior runs (slug-tagged). */
const scrubResidue = async () => {
  const orphans = await adminSql!`select id from organizations where slug like 'ana-live-%'`;
  for (const row of orphans) await wipeTenant(row.id as string);
  // Live-probe rows use per-run ids; anything left from an interrupted run
  // (e.g. an org-null dedupe probe) is removed here. The migrator role is
  // the table owner: DELETE is a provisioning operation, not a runtime one.
  await adminSql!`delete from analytics_events where ingest_event_id like 'live-%'`;
};

const provisionPublishedContent = async (tag: string) => {
  const slugBase = ("ana-live-" + tag).slice(0, 40);
  const orgId = (
    await adminSql!`insert into organizations (name, slug) values (${slugBase}, ${slugBase}) returning id`
  )[0]!.id as string;
  const pubId = (
    await adminSql!`insert into publications (org_id, subject_kind, subject_ref, platform_target, content_type, status)
      values (${orgId}::uuid, 'production', ${uuid()}::uuid, 'stratifit-media', 'film', 'published') returning id`
  )[0]!.id as string;
  const versionId = (
    await adminSql!`insert into publication_versions (org_id, publication_id, version_number, title, content_type, subject_kind, subject_ref)
      values (${orgId}::uuid, ${pubId}::uuid, 1, ${"Beacon " + tag}, 'film', 'production', ${uuid()}::uuid) returning id`
  )[0]!.id as string;
  const contentId = (
    await adminSql!`insert into public_content (org_id, publication_id, publication_version_id, slug, content_type, title, published_at, status)
      values (${orgId}::uuid, ${pubId}::uuid, ${versionId}::uuid, ${slugBase}, 'film', 'Beacon target', now(), 'published') returning id`
  )[0]!.id as string;
  return { orgId, pubId, versionId, contentId };
};

d("analytics intake live proofs (runtime role)", () => {
  beforeAll(async () => {
    if (adminSql) await scrubResidue();
  }, 30_000);

  it("runtime grants map = 54 distinct tables with analytics_events INSERT+SELECT only", { timeout: 30_000 }, async () => {
    const [counts] = await runtimeSql!`select count(distinct table_name)::int as n from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_schema = 'public'`;
    expect(counts!.n).toBe(64);
    const [ae] = await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = 'analytics_events' and table_schema = 'public'`;
    expect(ae!.privs).toBe("INSERT,SELECT");
  });

  it("RLS enabled on analytics_events with exactly the runtime_all policy TO stratifit_runtime", { timeout: 30_000 }, async () => {
    const [rls] = await runtimeSql!`select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'analytics_events'`;
    expect(rls!.rowsecurity).toBe(true);
    const pols = await runtimeSql!`select policyname, roles::text as roles from pg_policies where schemaname = 'public' and tablename = 'analytics_events'`;
    expect(pols).toHaveLength(1);
    expect(pols[0]!.policyname).toBe("runtime_all");
    expect(pols[0]!.roles).toContain("stratifit_runtime");
  });

  it("immutable family: UPDATE and DELETE are permission-denied (42501) and rows stay unchanged", { timeout: 30_000 }, async () => {
    const tag = "imm" + Date.now().toString(36);
    const t = await provisionPublishedContent(tag);
    try {
      const id = (
        await runtimeSql!`insert into analytics_events (event_type, content_ref, org_id, session_hash, ingest_event_id)
          values ('content_view', ${t.contentId}::uuid, ${t.orgId}::uuid, ${"a".repeat(64)}, ${"live-imm-" + tag}) returning id, session_hash`
      )[0]!;
      const upd = await runtimeSql!`update analytics_events set event_type = event_type where id = ${id.id}::uuid`.catch((e) => e.code);
      expect(upd).toBe("42501");
      const del = await runtimeSql!`delete from analytics_events where id = ${id.id}::uuid`.catch((e) => e.code);
      expect(del).toBe("42501");
      const [after] = await adminSql!`select session_hash from analytics_events where id = ${id.id}::uuid`;
      expect(after!.session_hash).toBe("a".repeat(64)); // unchanged
    } finally {
      await wipeTenant(t.orgId);
    }
  });

  it("CHECK constraints: unknown event_type and non-64-hex session_hash are rejected (23514)", { timeout: 30_000 }, async () => {
    const tag = "chk" + Date.now().toString(36);
    const t = await provisionPublishedContent(tag);
    try {
      const badType = await runtimeSql!`insert into analytics_events (event_type, session_hash, ingest_event_id)
        values ('page_view', ${"b".repeat(64)}, ${"live-chk-1"})`.catch((e) => e.code);
      expect(badType).toBe("23514");
      const badHash = await runtimeSql!`insert into analytics_events (event_type, session_hash, ingest_event_id)
        values ('content_view', 'tooshort', ${"live-chk-2"})`.catch((e) => e.code);
      expect(badHash).toBe("23514");
    } finally {
      await wipeTenant(t.orgId);
    }
  });

  it("UNIQUE(ingest_event_id) dedupes: onConflictDoNothing inserts nothing on replay (Case D live)", { timeout: 30_000 }, async () => {
    const tag = "uni" + Date.now().toString(36);
    const t = await provisionPublishedContent(tag);
    try {
      const dedupeId = "live-uni-" + tag;
      const first = await repo!.insertEventIfAbsent({
        eventType: "content_view",
        contentRef: t.contentId,
        orgId: t.orgId,
        audienceUserId: null,
        sessionHash: "c".repeat(64),
        properties: null,
        clientTs: null,
        ingestEventId: dedupeId,
      });
      expect(first).not.toBeNull();
      const second = await repo!.insertEventIfAbsent({
        eventType: "content_view",
        contentRef: t.contentId,
        orgId: t.orgId,
        audienceUserId: null,
        sessionHash: "c".repeat(64),
        properties: null,
        clientTs: null,
        ingestEventId: dedupeId,
      });
      expect(second).toBeNull(); // deduped, no second row, no error
      const [count] = await adminSql!`select count(*)::int as n from analytics_events where ingest_event_id = ${dedupeId}`;
      expect(count!.n).toBe(1);
    } finally {
      await wipeTenant(t.orgId);
    }
  });

  it("FK ON DELETE RESTRICT: analytics_events pins content/org rows (23503)", { timeout: 30_000 }, async () => {
    const tag = "fk" + Date.now().toString(36);
    const t = await provisionPublishedContent(tag);
    try {
      await runtimeSql!`insert into analytics_events (event_type, content_ref, org_id, session_hash, ingest_event_id)
        values ('content_complete', ${t.contentId}::uuid, ${t.orgId}::uuid, ${"d".repeat(64)}, ${"live-fk-" + tag})`;
      const delContent = await adminSql!`delete from public_content where id = ${t.contentId}`.catch((e) => e.code);
      expect(delContent).toBe("23503");
      const delOrg = await adminSql!`delete from organizations where id = ${t.orgId}`.catch((e) => e.code);
      expect(delOrg).toBe("23503");
    } finally {
      await wipeTenant(t.orgId);
    }
  });

  it("Case E end-to-end: real service+repo — anonymous accepted, org resolved server-side, event emitted POST-insert", { timeout: 30_000 }, async () => {
    const tag = "e2e" + Date.now().toString(36);
    const t = await provisionPublishedContent(tag);
    try {
      const e2eId = "live-e2e-" + tag;
      const emitted: Array<{ eventId: string; name: string }> = [];
      const service = createAnalyticsService({
        repository: repo!,
        rateLimiter: { consume: async () => true },
        publisher: async (envelope) => {
          emitted.push({ eventId: envelope.eventId, name: envelope.name });
        },
      });
      const res = await service.recordEvent({
        eventType: "content_view",
        contentRef: t.contentId,
        audienceUserId: null, // anonymous
        sessionId: "live-session-abcdef123",
        sourceIp: "203.0.113.50",
        properties: { duration_s: 12 },
        clientTs: null,
        eventId: e2eId,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.outcome.accepted).toBe(true);
      expect(res.value.outcome.deduped).toBe(false);
      // Server-side resolution: org came from the content row, never the client.
      const [row] = await adminSql!`select org_id, audience_user_id, session_hash, event_type, properties from analytics_events where ingest_event_id = ${e2eId}`;
      expect(row!.org_id).toBe(t.orgId);
      expect(row!.audience_user_id).toBeNull();
      expect(row!.session_hash).toBe(hashSessionId("live-session-abcdef123"));
      expect(row!.event_type).toBe("content_view");
      // A2 relationship + commit-before-event.
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.name).toBe("analytics.received");
      expect(emitted[0]!.eventId).toBe(e2eId);
      // Replay: deduped, no second emission.
      const replay = await service.recordEvent({
        eventType: "content_view",
        contentRef: t.contentId,
        audienceUserId: null,
        sessionId: "live-session-abcdef123",
        sourceIp: "203.0.113.50",
        properties: null,
        clientTs: null,
        eventId: e2eId,
      });
      expect(replay.ok && replay.value.outcome.deduped).toBe(true);
      expect(emitted).toHaveLength(1);
    } finally {
      await wipeTenant(t.orgId);
    }
  });

  it("Case E fail-closed: unknown/unpublished contentRef -> content_not_found, nothing persisted", { timeout: 30_000 }, async () => {
    const tag = "fail" + Date.now().toString(36);
    const t = await provisionPublishedContent(tag);
    try {
      // Unpublish the projection: resolution is published-only.
      await adminSql!`update public_content set status = 'unpublished' where id = ${t.contentId}`;
      const emitted: string[] = [];
      const service = createAnalyticsService({
        repository: repo!,
        rateLimiter: { consume: async () => true },
        publisher: async (envelope) => {
          emitted.push(envelope.name);
        },
      });
      const res = await service.recordEvent({
        eventType: "content_view",
        contentRef: t.contentId,
        audienceUserId: null,
        sessionId: "live-session-abcdef456",
        sourceIp: "203.0.113.51",
        properties: null,
        clientTs: null,
        eventId: "live-fail-" + tag,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.reason).toBe("content_not_found");
      expect(emitted).toHaveLength(0);
      const [count] = await adminSql!`select count(*)::int as n from analytics_events where ingest_event_id = ${'live-fail-' + tag}`;
      expect(count!.n).toBe(0);
    } finally {
      await wipeTenant(t.orgId);
    }
  });

  it("Case E CONCURRENT duplicate: two simultaneous identical events -> exactly one row, exactly one emission, one deduped report", { timeout: 30_000 }, async () => {
    const tag = "conc" + Date.now().toString(36);
    const t = await provisionPublishedContent(tag);
    try {
      const emitted: string[] = [];
      const service = createAnalyticsService({
        repository: repo!,
        rateLimiter: { consume: async () => true },
        publisher: async (envelope) => {
          emitted.push(envelope.eventId);
        },
      });
      const eventId = "live-conc-" + tag;
      const input = {
        eventType: "content_view" as const,
        contentRef: t.contentId,
        audienceUserId: null,
        sessionId: "live-session-concurrent000",
        sourceIp: "203.0.113.60",
        properties: null,
        clientTs: null,
        eventId,
      };
      // Two IDENTICAL events racing the same ingest_event_id. The UNIQUE
      // constraint serializes the inserts inside PostgreSQL; exactly one
      // insert lands. The service therefore emits EXACTLY ONE event and
      // reports exactly one dedupe — the concurrent-proof of
      // commit-before-event (a pre-commit emission would emit twice).
      const [r1, r2] = await Promise.all([service.recordEvent(input), service.recordEvent(input)]);
      const outcomes = [r1, r2].map((r) => (r.ok ? r.value.outcome : null));
      expect(outcomes.filter((o) => o && o.accepted)).toHaveLength(2);
      expect(outcomes.filter((o) => o && o.deduped)).toHaveLength(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toBe(eventId);
      const [count] = await adminSql!`select count(*)::int as n from analytics_events where ingest_event_id = ${eventId}`;
      expect(count!.n).toBe(1);
    } finally {
      await wipeTenant(t.orgId);
    }
  });

  afterAll(async () => {
    await adminSql?.end({ timeout: 1 });
    await runtimeSql?.end({ timeout: 1 });
  });
});
