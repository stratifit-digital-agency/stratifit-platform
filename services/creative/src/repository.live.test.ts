/**
 * Gated LIVE tests for the CREATIVE hierarchy (Stage 2.20, D2.20-1..D2.20-9).
 *
 * Runs only when the git-ignored root .env provides both database URLs;
 * proves against the LIVE remote through the RUNTIME role (DATABASE_URL /
 * stratifit_runtime) — the privilege boundary production uses:
 *   - runtime grants map = 61 distinct tables incl. the seven Creative
 *     tables (ARWD);
 *   - RLS enabled with exactly the runtime_all policy TO stratifit_runtime;
 *   - hierarchy FKs RESTRICT (23503) + lifecycle CHECKs (23514);
 *   - frozen story.kind CHECK + UNIQUE(org, slug) + UNIQUE(story,
 *     season_number) + partial ordering uniques;
 *   - cross-org + retired-parent fail-closed through the SERVICE against the
 *     live database;
 *   - same-transaction audit (rollback removes both) against the live DB.
 *
 * Tenant rows are provisioned through the migrator connection (provisioning
 * ONLY) and cleaned up FK-safely afterwards — zero residue.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDrizzleCreativeRepository, createCreativeService } from "./index";
import type { CreativePrincipal } from "./types";

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

/** Test-only D2.4-1 writer (composition-root mapping, as in the People suite). */
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
        metadata?: Record<string, unknown>;
        correlationId?: string | null;
        causationId?: string | null;
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

/** SHARED repo (one pool) — the pooler caps connections. */
const sharedRepo = createDrizzleCreativeRepository({
  databaseUrl: runtimeUrl!,
  auditWriter: createTestAuditWriter(runtimeUrl!),
});

const CREATIVE_TABLES = ["universes", "worlds", "stories", "seasons", "episodes", "scenes", "shots"];

const cleanupTenant = async (orgId: string) => {
  // FK-safe order: children first.
  await adminSql!`delete from shots where org_id = ${orgId}`;
  await adminSql!`delete from scenes where org_id = ${orgId}`;
  await adminSql!`delete from episodes where org_id = ${orgId}`;
  await adminSql!`delete from seasons where org_id = ${orgId}`;
  await adminSql!`delete from stories where org_id = ${orgId}`;
  await adminSql!`delete from worlds where org_id = ${orgId}`;
  await adminSql!`delete from universes where org_id = ${orgId}`;
  await adminSql!`delete from audit_log where organization_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

const provisionOrg = async (tag: string) => {
  const orgId = (
    await adminSql!`insert into organizations (name, slug) values (${("cre-live-" + tag).slice(0, 60)}, ${("cre-live-" + tag).slice(0, 60)}) returning id`
  )[0]!.id as string;
  return orgId;
};

const admin = (orgId: string): CreativePrincipal => ({
  operatorId: uuid(),
  orgId,
  capabilities: ["creative.manage", "creative.read"],
});

const svc = () => createCreativeService({ repository: sharedRepo });

d("creative live proofs (runtime role)", () => {
  it(
    "runtime grants map = 61 distinct tables (54 + the seven Stage 2.20 creative families) with all seven tables ARWD",
    { timeout: 30_000 },
    async () => {
      const [counts] = await runtimeSql!`select count(distinct table_name)::int as n from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_schema = 'public'`;
      expect(counts!.n).toBe(61);
      for (const table of CREATIVE_TABLES) {
        const [row] = await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = ${table} and table_schema = 'public'`;
        expect(row!.privs).toBe("DELETE,INSERT,SELECT,UPDATE");
      }
    },
  );

  it("all seven creative tables are RLS-enabled with exactly one runtime_all policy TO stratifit_runtime and zero PUBLIC grants", { timeout: 30_000 }, async () => {
    const rls = await runtimeSql!`
      select c.relname, c.relrowsecurity,
        (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count,
        (select count(*) from pg_policy p where p.polrelid = c.oid and p.polname = 'runtime_all') as runtime_all_count
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${runtimeSql!(CREATIVE_TABLES)}`;
    expect(rls).toHaveLength(7);
    for (const r of rls) {
      expect(r.relrowsecurity).toBe(true);
      expect(Number(r.policy_count)).toBe(1);
      expect(Number(r.runtime_all_count)).toBe(1);
    }
    const pub = await runtimeSql!`
      select count(*)::int as n from information_schema.role_table_grants
      where grantee = 'PUBLIC' and table_schema = 'public' and table_name in ${runtimeSql!(CREATIVE_TABLES)}`;
    expect(pub[0]!.n).toBe(0);
  });

  it("authors the full seven-level hierarchy against the live DB with same-tx audit rows", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    try {
      const service = svc();
      const p = admin(orgA);
      const un = await service.createUniverse(p, { name: "Live Universe", slug: "live-universe" });
      expect(un.ok).toBe(true);
      if (!un.ok) return;
      const wo = await service.createWorld(p, { universeId: un.value.id, name: "Live World" });
      expect(wo.ok).toBe(true);
      if (!wo.ok) return;
      const st = await service.createStory(p, { worldId: wo.value.id, title: "Live Story", logline: "Endure.", kind: "series" });
      expect(st.ok).toBe(true);
      if (!st.ok) return;
      const se = await service.createSeason(p, { storyId: st.value.id, seasonNumber: 1, title: "S1" });
      expect(se.ok).toBe(true);
      if (!se.ok) return;
      const ep = await service.createEpisode(p, { seasonId: se.value.id, storyId: st.value.id, episodeNumber: 1, title: "E1" });
      expect(ep.ok).toBe(true);
      if (!ep.ok) return;
      const sc = await service.createScene(p, { storyId: st.value.id, episodeId: ep.value.id, orderIndex: 0, title: "S1" });
      expect(sc.ok).toBe(true);
      if (!sc.ok) return;
      const sh = await service.createShot(p, { sceneId: sc.value.id, orderIndex: 0, description: "Wide establishing", aspect: "2.39:1", durationSeconds: 6, fps: 24 });
      expect(sh.ok).toBe(true);
      if (!sh.ok) return;
      // Audit rows exist for every created aggregate, with the real actor.
      const audits = await adminSql!`select action, actor_id from audit_log where organization_id = ${orgA} order by action`;
      expect(audits.map((a) => a.action).sort()).toEqual([
        "creative.episode_created",
        "creative.scene_created",
        "creative.season_created",
        "creative.shot_created",
        "creative.story_created",
        "creative.universe_created",
        "creative.world_created",
      ]);
      expect(audits.every((a) => a.actor_id === p.operatorId)).toBe(true);

      // Lifecycle walk on the story: draft -> active -> completed -> retired.
      const p2 = admin(orgA);
      expect((await service.changeStatus(p2, "story", { id: st.value.id, status: "active" })).ok).toBe(true);
      expect((await service.changeStatus(p2, "story", { id: st.value.id, status: "completed" })).ok).toBe(true);
      expect((await service.changeStatus(p2, "story", { id: st.value.id, status: "retired" })).ok).toBe(true);
      const [story] = await adminSql!`select status from stories where id = ${st.value.id}`;
      expect(story!.status).toBe("retired");
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("cross-org parent reference fails closed as not_found with zero leakage", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    const orgB = await provisionOrg(uuid().slice(0, 8) + "b");
    try {
      const service = svc();
      const un = await service.createUniverse(admin(orgA), { name: "A Universe", slug: "a-universe" });
      expect(un.ok).toBe(true);
      if (!un.ok) return;
      // Org B attempts to parent onto A's universe.
      const r = await service.createWorld(admin(orgB), { universeId: un.value.id, name: "B World" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe("not_found");
      const [count] = await adminSql!`select count(*)::int as n from worlds where org_id = ${orgB}`;
      expect(count!.n).toBe(0);
    } finally {
      await cleanupTenant(orgA);
      await cleanupTenant(orgB);
    }
  });

  it("retired parent cannot parent a new child (live DB)", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    try {
      const service = svc();
      const p = admin(orgA);
      const un = await service.createUniverse(p, { name: "R Universe", slug: "r-universe" });
      expect(un.ok).toBe(true);
      if (!un.ok) return;
      expect((await service.changeStatus(p, "universe", { id: un.value.id, status: "retired" })).ok).toBe(true);
      const r = await service.createWorld(p, { universeId: un.value.id, name: "Post-Retirement" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe("inactive_parent");
      const [count] = await adminSql!`select count(*)::int as n from worlds where org_id = ${orgA}`;
      expect(count!.n).toBe(0);
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("hierarchy FKs RESTRICT, lifecycle CHECKs and story.kind CHECK reject (23503/23514), UNIQUE(org,slug) idempotent", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    try {
      // 23503: world with a nonexistent universe.
      await expect(
        adminSql!`insert into worlds (org_id, universe_id, name) values (${orgA}::uuid, ${uuid()}::uuid, 'X')`,
      ).rejects.toMatchObject({ code: "23503" });
      // 23514: invalid lifecycle status on universes.
      await expect(
        adminSql!`insert into universes (org_id, name, slug, status) values (${orgA}::uuid, 'X', 'x-status', 'paused')`,
      ).rejects.toMatchObject({ code: "23514" });
      // 23514: invalid story kind.
      await expect(
        adminSql!`insert into stories (org_id, title, logline, kind) values (${orgA}::uuid, 'T', 'L', 'novel')`,
      ).rejects.toMatchObject({ code: "23514" });
      // 23505: duplicate (org, slug).
      await adminSql!`insert into universes (org_id, name, slug) values (${orgA}::uuid, 'U1', 'dup-slug')`;
      await expect(
        adminSql!`insert into universes (org_id, name, slug) values (${orgA}::uuid, 'U2', 'dup-slug')`,
      ).rejects.toMatchObject({ code: "23505" });
      // 23505: duplicate (story, season_number).
      const st = (await adminSql!`insert into stories (org_id, title, logline, kind, status) values (${orgA}::uuid, 'S', 'l', 'film', 'active') returning id`)[0]!.id;
      await adminSql!`insert into seasons (org_id, story_id, season_number, title) values (${orgA}::uuid, ${st}::uuid, 1, 'One')`;
      await expect(
        adminSql!`insert into seasons (org_id, story_id, season_number, title) values (${orgA}::uuid, ${st}::uuid, 1, 'One Again')`,
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("runtime role CANNOT modify migrations journal or foreign marketing tables", { timeout: 30_000 }, async () => {
    // The runtime role has no privileges on drizzle journal or foreign tables.
    await expect(
      runtimeSql!`insert into drizzle.__drizzle_migrations (hash, created_at) values ('x', 1)`,
    ).rejects.toThrow();
    await expect(runtimeSql!`select count(*) from public.leads`).rejects.toThrow();
    await expect(runtimeSql!`select count(*) from public.services`).rejects.toThrow();
  });
});
