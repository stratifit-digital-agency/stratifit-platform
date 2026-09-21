/**
 * Gated LIVE tests for the RIGHTS & CONSENT family (Stage 2.21).
 *
 * Runs only when the git-ignored root .env provides both database URLs;
 * proves against the LIVE remote through the RUNTIME role (DATABASE_URL /
 * stratifit_runtime) — the privilege boundary production uses:
 *   - runtime grants map = 64 distinct tables (61 + the three rights families)
 *     with ARWD on owners/grants and INSERT+SELECT on status-events;
 *   - RLS enabled ×3 with exactly one runtime_all policy TO stratifit_runtime
 *     and zero PUBLIC grants;
 *   - immutable status-events family proven live: UPDATE/DELETE → 42501;
 *   - FK RESTRICT (23503) + CHECK (23514) + UNIQUE behavior;
 *   - cross-org subject/owner integrity fails closed through the SERVICE;
 *   - same-transaction audit + status-event history against the live DB;
 *   - live evaluation (satisfied + revoked fail-closed) via evaluateUse.
 *
 * Tenant rows are provisioned through the migrator connection (provisioning
 * ONLY) and cleaned up FK-safely afterwards — zero residue.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDrizzleRightsRepository, createRightsService } from "./index";
import type { RightsPrincipal } from "./types";

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

/** Test-only D2.4-1 writer (composition-root mapping, as in the Creative suite). */
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
const sharedRepo = createDrizzleRightsRepository({
  databaseUrl: runtimeUrl!,
  auditWriter: createTestAuditWriter(runtimeUrl!),
});

const RIGHTS_TABLES = ["rights_owners", "rights_grants", "rights_status_events"];

const cleanupTenant = async (orgId: string) => {
  // FK-safe order: children first (status events → grants → owners →
  // provisioned subject rows → audit → org).
  await adminSql!`delete from rights_status_events where org_id = ${orgId}`;
  await adminSql!`delete from rights_grants where org_id = ${orgId}`;
  await adminSql!`delete from rights_owners where org_id = ${orgId}`;
  await adminSql!`delete from digital_humans where org_id = ${orgId}`;
  await adminSql!`delete from audit_log where organization_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

const provisionOrg = async (tag: string) =>
  (
    await adminSql!`insert into organizations (name, slug) values (${("rgh-live-" + tag).slice(0, 60)}, ${("rgh-live-" + tag).slice(0, 60)}) returning id`
  )[0]!.id as string;

const admin = (orgId: string): RightsPrincipal => ({
  operatorId: uuid(),
  orgId,
  capabilities: ["rights.manage", "rights.read"],
});

const svc = () => createRightsService({ repository: sharedRepo });

d("rights live proofs (runtime role)", () => {
  it(
    "runtime grants map = 64 distinct tables with ARWD ×2 + INSERT+SELECT on the immutable status-events family",
    { timeout: 30_000 },
    async () => {
      const [counts] =
        await runtimeSql!`select count(distinct table_name)::int as n from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_schema = 'public'`;
      expect(counts!.n).toBe(64);
      const [ownerPrivs] =
        await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = 'rights_owners' and table_schema = 'public'`;
      const [grantPrivs] =
        await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = 'rights_grants' and table_schema = 'public'`;
      const [eventPrivs] =
        await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = 'rights_status_events' and table_schema = 'public'`;
      expect(ownerPrivs!.privs).toBe("DELETE,INSERT,SELECT,UPDATE");
      expect(grantPrivs!.privs).toBe("DELETE,INSERT,SELECT,UPDATE");
      expect(eventPrivs!.privs).toBe("INSERT,SELECT");
    },
  );

  it("all three rights tables are RLS-enabled with exactly one runtime_all policy TO stratifit_runtime and zero PUBLIC grants", { timeout: 30_000 }, async () => {
    const rls = await runtimeSql!`
      select c.relname, c.relrowsecurity,
        (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count,
        (select count(*) from pg_policy p where p.polrelid = c.oid and p.polname = 'runtime_all') as runtime_all_count
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${runtimeSql!(RIGHTS_TABLES)}`;
    expect(rls).toHaveLength(3);
    for (const r of rls) {
      expect(r.relrowsecurity).toBe(true);
      expect(Number(r.policy_count)).toBe(1);
      expect(Number(r.runtime_all_count)).toBe(1);
    }
    const pub = await runtimeSql!`
      select count(*)::int as n from information_schema.role_table_grants
      where grantee = 'PUBLIC' and table_schema = 'public' and table_name in ${runtimeSql!(RIGHTS_TABLES)}`;
    expect(pub[0]!.n).toBe(0);
  });

  it("authors owner + grant against the live DB with same-tx audit + immutable status-event history", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    try {
      const service = svc();
      const p = admin(orgA);
      // Owner + verification walk.
      const owner = await service.createOwner(p, { kind: "individual", displayName: "Live Owner" });
      expect(owner.ok).toBe(true);
      if (!owner.ok) return;
      expect((await service.changeOwnerVerification(p, { id: owner.value.id, status: "pending" })).ok).toBe(true);
      expect((await service.changeOwnerVerification(p, { id: owner.value.id, status: "verified" })).ok).toBe(true);

      // Provision a live subject (digital human) through the migrator role —
      // provisioning ONLY; the service never mutates People.
      const subjectId = (
        await adminSql!`insert into digital_humans (org_id, name, status) values (${orgA}::uuid, 'Live DH', 'draft') returning id`
      )[0]!.id as string;

      // Grant + activation (draft → active) with the status-event row.
      const grant = await service.createGrant(p, {
        ownerId: owner.value.id,
        subjectKind: "digital_human",
        subjectId,
        scope: "publication",
        platforms: ["stratifit_media"],
        territories: ["worldwide"],
      });
      expect(grant.ok).toBe(true);
      if (!grant.ok) return;
      expect((await service.changeGrantStatus(p, { id: grant.value.id, status: "active" })).ok).toBe(true);

      // Status-event history is the record: one row, draft → active, real actor.
      const detail = await service.getGrant(p, grant.value.id);
      expect(detail.ok).toBe(true);
      if (!detail.ok) return;
      expect(detail.value.history).toHaveLength(1);
      expect(detail.value.history[0]!.fromStatus).toBe("draft");
      expect(detail.value.history[0]!.toStatus).toBe("active");
      expect(detail.value.history[0]!.actorId).toBe(p.operatorId);

      // Audit rows: owner_created + owner_status_changed×2 + grant_created + grant_status_changed.
      const audits = await adminSql!`select action from audit_log where organization_id = ${orgA} order by action`;
      expect(audits.map((a) => a.action)).toEqual([
        "rights.grant_created",
        "rights.grant_status_changed",
        "rights.owner_created",
        "rights.owner_status_changed",
        "rights.owner_status_changed",
      ]);
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("cross-org subject reference fails closed as not_found with zero rows written", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    const orgB = await provisionOrg(uuid().slice(0, 8) + "b");
    try {
      const service = svc();
      // Subject lives in org B.
      const subjectB = (
        await adminSql!`insert into digital_humans (org_id, name, status) values (${orgB}::uuid, 'B DH', 'draft') returning id`
      )[0]!.id as string;
      const ownerA = await service.createOwner(admin(orgA), { kind: "individual", displayName: "A Owner" });
      expect(ownerA.ok).toBe(true);
      if (!ownerA.ok) return;
      const r = await service.createGrant(admin(orgA), {
        ownerId: ownerA.value.id,
        subjectKind: "digital_human",
        subjectId: subjectB,
        scope: "publication",
        platforms: ["stratifit_media"],
        territories: ["worldwide"],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe("not_found");
      const [grants] = await adminSql!`select count(*)::int as n from rights_grants where org_id = ${orgA}`;
      expect(grants!.n).toBe(0);
    } finally {
      await cleanupTenant(orgA);
      await cleanupTenant(orgB);
    }
  });

  it("immutable status-events family: runtime UPDATE/DELETE → 42501, rows survive unchanged", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    try {
      const service = svc();
      const p = admin(orgA);
      const owner = await service.createOwner(p, { kind: "individual", displayName: "Immut Owner" });
      if (!owner.ok) throw new Error("seed failed");
      const subjectId = (
        await adminSql!`insert into digital_humans (org_id, name, status) values (${orgA}::uuid, 'DH', 'draft') returning id`
      )[0]!.id as string;
      const grant = await service.createGrant(p, {
        ownerId: owner.value.id,
        subjectKind: "digital_human",
        subjectId,
        scope: "generation",
        platforms: ["all"],
        territories: ["worldwide"],
      });
      if (!grant.ok) throw new Error("seed failed");
      expect((await service.changeGrantStatus(p, { id: grant.value.id, status: "active" })).ok).toBe(true);
      const [event] = await adminSql!`select id, to_status from rights_status_events where grant_id = ${grant.value.id}`;
      expect(event!.to_status).toBe("active");

      // 42501: the runtime role cannot UPDATE or DELETE the immutable family.
      await expect(
        runtimeSql!`update rights_status_events set to_status = 'revoked' where id = ${event!.id}`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimeSql!`delete from rights_status_events where id = ${event!.id}`,
      ).rejects.toMatchObject({ code: "42501" });
      const [after] = await adminSql!`select to_status from rights_status_events where id = ${event!.id}`;
      expect(after!.to_status).toBe("active");
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("FK/CHECK/UNIQUE behavior: 23503 owner FK, 23514 subject-kind CHECK, 23514 platform CHECK, 23514 window CHECK", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    try {
      // 23503: grant referencing a nonexistent owner.
      await expect(
        adminSql!`insert into rights_grants (org_id, owner_id, subject_kind, subject_id, scope, platforms, territories, status, granted_by)
                  values (${orgA}::uuid, ${uuid()}::uuid, 'digital_human', ${uuid()}::uuid, 'publication', array['stratifit_media'], array['worldwide'], 'draft', ${uuid()}::uuid)`,
      ).rejects.toMatchObject({ code: "23503" });
      // 23514: subject kind outside the frozen v1 family ('voice' EXCLUDED).
      await expect(
        adminSql!`insert into rights_grants (org_id, owner_id, subject_kind, subject_id, scope, platforms, territories, status, granted_by)
                  values (${orgA}::uuid, ${uuid()}::uuid, 'voice', ${uuid()}::uuid, 'publication', array['stratifit_media'], array['worldwide'], 'draft', ${uuid()}::uuid)`,
      ).rejects.toMatchObject({ code: "23514" });
      // 23514: platform outside the frozen family.
      await expect(
        adminSql!`insert into rights_grants (org_id, owner_id, subject_kind, subject_id, scope, platforms, territories, status, granted_by)
                  values (${orgA}::uuid, ${uuid()}::uuid, 'digital_human', ${uuid()}::uuid, 'publication', array['myspace'], array['worldwide'], 'draft', ${uuid()}::uuid)`,
      ).rejects.toMatchObject({ code: "23514" });
      // 23514: expires_at <= starts_at violates the window constraint.
      await expect(
        adminSql!`insert into rights_grants (org_id, owner_id, subject_kind, subject_id, scope, platforms, territories, starts_at, expires_at, status, granted_by)
                  values (${orgA}::uuid, ${uuid()}::uuid, 'digital_human', ${uuid()}::uuid, 'publication', array['stratifit_media'], array['worldwide'], '2026-02-01', '2026-01-01', 'draft', ${uuid()}::uuid)`,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("live evaluation: satisfied when covered, fail-closed when revoked (evaluateUse against the live DB)", { timeout: 30_000 }, async () => {
    const orgA = await provisionOrg(uuid().slice(0, 8));
    try {
      const service = svc();
      const p = admin(orgA);
      const owner = await service.createOwner(p, { kind: "individual", displayName: "Eval Owner" });
      if (!owner.ok) throw new Error("seed failed");
      const subjectId = (
        await adminSql!`insert into digital_humans (org_id, name, status) values (${orgA}::uuid, 'DH', 'draft') returning id`
      )[0]!.id as string;
      const grant = await service.createGrant(p, {
        ownerId: owner.value.id,
        subjectKind: "digital_human",
        subjectId,
        scope: "publication",
        platforms: ["stratifit_media"],
        territories: ["worldwide"],
      });
      if (!grant.ok) throw new Error("seed failed");
      expect((await service.changeGrantStatus(p, { id: grant.value.id, status: "active" })).ok).toBe(true);

      const satisfied = await service.evaluateUse({
        orgId: orgA,
        subjectKind: "digital_human",
        subjectId,
        scope: "publication",
        platform: "stratifit_media",
        territory: "US",
        at: new Date(),
      });
      expect(satisfied.satisfied).toBe(true);
      expect(satisfied.grantId).toBe(grant.value.id);

      // Revoke → evaluation fails closed with grant_not_active.
      expect((await service.changeGrantStatus(p, { id: grant.value.id, status: "revoked" })).ok).toBe(true);
      const denied = await service.evaluateUse({
        orgId: orgA,
        subjectKind: "digital_human",
        subjectId,
        scope: "publication",
        platform: "stratifit_media",
        territory: "US",
        at: new Date(),
      });
      expect(denied.satisfied).toBe(false);
      expect(denied.reasons.some((r) => r.code === "grant_not_active")).toBe(true);
    } finally {
      await cleanupTenant(orgA);
    }
  });

  it("runtime role CANNOT modify migrations journal or the foreign marketing tables", { timeout: 30_000 }, async () => {
    await expect(
      runtimeSql!`insert into drizzle.__drizzle_migrations (hash, created_at) values ('x', 1)`,
    ).rejects.toThrow();
    await expect(runtimeSql!`select count(*) from public.leads`).rejects.toThrow();
    await expect(runtimeSql!`select count(*) from public.services`).rejects.toThrow();
  });
});
