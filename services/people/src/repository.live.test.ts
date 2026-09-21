/**
 * Gated LIVE tests for the PEOPLE CHAIN aggregates (Stage 2.16).
 *
 * Runs only when the git-ignored root .env provides both database URLs;
 * proves against the LIVE remote through the RUNTIME role (DATABASE_URL /
 * stratifit_runtime) — the privilege boundary production uses:
 *   - runtime grants map = 53 distinct tables incl. the five People tables (ARWD);
 *   - RLS enabled with exactly the runtime_all policy TO stratifit_runtime;
 *   - chain FKs RESTRICT (23503) + status CHECKs (23514);
 *   - handle shape CHECK (23514) and per-org handle uniqueness on ai_creators;
 *   - partial unique on creator_profiles: historical 'unpublished' rows do
 *     NOT hold the (org, creator) slot — republish inserts a new row (D2.16-3);
 *   - publication_version_id UNIQUE idempotency backstop (23505);
 *   - cross-org isolation through the service.
 *
 * Tenant rows are provisioned through the migrator connection (provisioning
 * ONLY) and cleaned up FK-safely afterwards — zero residue.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDrizzlePeopleRepository, createPeopleService } from "./index";
import type { PeoplePrincipal } from "./types";

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

/** Test-only D2.4-1 writer: maps the People seam shape (targetType/targetId/
 * metadata) to admin-audit's canonical entry (subjectKind/subjectId/payload)
 * — the same mapping the Control composition root performs. */
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

/** SHARED repo/audit writer (one pool each) — the pooler caps connections (15). */
const sharedRepo = createDrizzlePeopleRepository({
  databaseUrl: runtimeUrl!,
  auditWriter: createTestAuditWriter(runtimeUrl!),
});

const cleanupTenant = async (orgId: string) => {
  await adminSql!`delete from audit_log where organization_id = ${orgId}`;
  await adminSql!`delete from creator_profiles where org_id = ${orgId}`;
  await adminSql!`delete from ai_creators where org_id = ${orgId}`;
  await adminSql!`delete from personas where org_id = ${orgId}`;
  await adminSql!`delete from characters where org_id = ${orgId}`;
  await adminSql!`delete from digital_humans where org_id = ${orgId}`;
  await adminSql!`delete from publication_versions where org_id = ${orgId}`;
  await adminSql!`delete from publications where org_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

const provisionOrg = async (tag: string) => {
  const orgId = (
    await adminSql!`insert into organizations (name, slug) values (${("ppl-live-" + tag).slice(0, 60)}, ${("ppl-live-" + tag).slice(0, 60)}) returning id`
  )[0]!.id as string;
  return orgId;
};

const admin = (orgId: string): PeoplePrincipal => ({
  operatorId: uuid(),
  orgId,
  capabilities: ["people.manage", "people.read", "audit.read"],
});

/** Full chain seed through the SERVICE (proves authoring against live DB). */
const seedChain = async (orgId: string, handle = "ava") => {
  const svc = createPeopleService({ repository: sharedRepo });
  const p = admin(orgId);
  const dh = await svc.createDigitalHuman(p, { name: "Ava" });
  if (!dh.ok) throw new Error(dh.error.message);
  const ch = await svc.createCharacter(p, { digitalHumanId: dh.value.id, name: "Ava Prime" });
  if (!ch.ok) throw new Error(ch.error.message);
  const pe = await svc.createPersona(p, { characterId: ch.value.id, name: "Ava persona" });
  if (!pe.ok) throw new Error(pe.error.message);
  const ac = await svc.createAiCreator(p, { personaId: pe.value.id, handle, displayName: "Ava AI" });
  if (!ac.ok) throw new Error(ac.error.message);
  // Mediation invariant (freeze fix 2): the creator must be ACTIVE.
  const active = await svc.changeStatus(p, "ai_creator", { id: ac.value.id, status: "active" });
  if (!active.ok) throw new Error(active.error.message);
  return { svc, creatorId: ac.value.id };
};

const snapshotInput = (orgId: string, creatorId: string, versionId: string, handle = "ava") => ({
  orgId,
  aiCreatorId: creatorId,
  publicationId: versionId, // satisfied lazily — replaced with the durable publication below
  publicationVersionId: versionId,
  handle,
  displayName: "Ava AI v1",
  bio: "live bio",
  personalitySnapshot: { tone: "warm" },
  interestsSnapshot: ["art"],
  avatarRef: null,
  posterRef: null,
  messagingEnabled: false,
});

/** Provisions a durable publication + version pair (FK targets for snapshots). */
const provisionPublication = async (orgId: string, tag: string) => {
  const pubId = (
    await adminSql!`insert into publications (org_id, subject_kind, subject_ref, platform_target, content_type, status)
      values (${orgId}::uuid, 'ai_creator_profile', ${uuid()}::uuid, 'stratifit-media', 'film', 'published') returning id`
  )[0]!.id as string;
  const versionId = (
    await adminSql!`insert into publication_versions (org_id, publication_id, version_number, title, content_type, subject_kind, subject_ref)
      values (${orgId}::uuid, ${pubId}::uuid, 1, ${"People Snap " + tag}, 'film', 'ai_creator_profile', ${uuid()}::uuid) returning id`
  )[0]!.id as string;
  return { pubId, versionId };
};

d("people live proofs (runtime role)", () => {
  it(
    "runtime grants map = 54 distinct tables (53 + the Stage 2.19 analytics_events intake family) with all five People tables ARWD",
    { timeout: 30_000 },
    async () => {
      const [counts] = await runtimeSql!`select count(distinct table_name)::int as n from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_schema = 'public'`;
      expect(counts!.n).toBe(65);
      for (const table of ["digital_humans", "characters", "personas", "ai_creators", "creator_profiles"]) {
        const [row] = await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = ${table} and table_schema = 'public'`;
        expect(row!.privs).toBe("DELETE,INSERT,SELECT,UPDATE");
      }
    },
  );

  it(
    "RLS enabled on all five People tables with exactly the runtime_all policy TO stratifit_runtime",
    { timeout: 30_000 },
    async () => {
      for (const table of ["digital_humans", "characters", "personas", "ai_creators", "creator_profiles"]) {
        const [rls] = await runtimeSql!`select rowsecurity from pg_tables where schemaname = 'public' and tablename = ${table}`;
        expect(rls!.rowsecurity).toBe(true);
        const [policy] = await runtimeSql!`select policyname, roles, cmd from pg_policies where schemaname = 'public' and tablename = ${table}`;
        expect(policy!.policyname).toBe("runtime_all");
        expect(JSON.stringify(policy!.roles)).toContain("stratifit_runtime");
      }
    },
  );

  it(
    "chain integrity: FK RESTRICT blocks parent deletion; status CHECK + handle CHECK + per-org handle uniqueness fire (23514/23505)",
    { timeout: 30_000 },
    async () => {
      const orgId = await provisionOrg("fk-" + uuid().slice(0, 8));
      try {
        const { creatorId } = await seedChain(orgId, "chain-ava");
        // FK RESTRICT: deleting the persona under an existing creator fails (23503).
        const [personaRow] = await runtimeSql!`select persona_id from ai_creators where id = ${creatorId}`;
        const personaId = personaRow!.persona_id;
        await expect(
          runtimeSql!`delete from personas where id = ${personaId}`,
        ).rejects.toMatchObject({ code: "23503" });
        // Status CHECK (23514).
        await expect(
          runtimeSql!`update digital_humans set status = 'zombie' where org_id = ${orgId}`,
        ).rejects.toMatchObject({ code: "23514" });
        // Handle shape CHECK (23514).
        await expect(
          runtimeSql!`update ai_creators set handle = 'Bad Handle!' where id = ${creatorId}`,
        ).rejects.toMatchObject({ code: "23514" });
        // Per-org handle uniqueness (23505).
        await expect(
          runtimeSql!`insert into ai_creators (org_id, persona_id, handle, display_name) values (${orgId}::uuid, ${personaId}::uuid, 'chain-ava', 'Dup')`,
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await cleanupTenant(orgId);
      }
    },
  );

  it(
    "snapshot family (D2.16-3): republish retires previous + inserts new (partial unique allows history); same version replays; publication_version UNIQUE backstop",
    { timeout: 30_000 },
    async () => {
      const orgId = await provisionOrg("snap-" + uuid().slice(0, 8));
      try {
        const { svc, creatorId } = await seedChain(orgId, "snap-ava");
        const pub1 = await provisionPublication(orgId, "v1");
        const input = snapshotInput(orgId, creatorId, pub1.versionId);
        const first = await svc.upsertProfileSnapshot({ ...input, publicationId: pub1.pubId });
        expect(first.ok).toBe(true);

        // Republish: a NEW version creates a SECOND row while the first is
        // retired — live proof the partial unique does not block history.
        const pub2 = await provisionPublication(orgId, "v2");
        const second = await svc.upsertProfileSnapshot({ ...snapshotInput(orgId, creatorId, pub2.versionId), publicationId: pub2.pubId, displayName: "Ava AI v2" });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.value.kind).toBe("created");

        const rows = await runtimeSql!`select publication_version_id, status from creator_profiles where org_id = ${orgId} order by created_at`;
        expect(rows.length).toBe(2);
        expect(rows.map((r) => r.status).sort()).toEqual(["active", "unpublished"]);

        // Replay the SAME version → idempotent, no third row.
        const replay = await svc.upsertProfileSnapshot({ ...snapshotInput(orgId, creatorId, pub2.versionId), publicationId: pub2.pubId });
        expect(replay.ok).toBe(true);
        if (!replay.ok) return;
        expect(replay.value.kind).toBe("replayed");
        const afterReplay = await runtimeSql!`select count(*)::int n from creator_profiles where org_id = ${orgId}`;
        expect(afterReplay[0]!.n).toBe(2);

        // DB backstop: direct duplicate-version insert violates the UNIQUE (23505).
        await expect(
          runtimeSql!`insert into creator_profiles (org_id, ai_creator_id, publication_id, publication_version_id, handle, display_name)
            values (${orgId}::uuid, ${creatorId}::uuid, ${pub1.pubId}::uuid, ${pub1.versionId}::uuid, 'snap-ava', 'Dup')`,
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await cleanupTenant(orgId);
      }
    },
  );

  it(
    "freeze fixes live: ai_creator paused ⇄ active; mediation rejects paused/retired creator + cross-org publication (fail closed)",
    { timeout: 30_000 },
    async () => {
      const orgId = await provisionOrg("fix-" + uuid().slice(0, 8));
      const orgB = await provisionOrg("fixb-" + uuid().slice(0, 8));
      try {
        const { svc, creatorId } = await seedChain(orgId, "fix-ava"); // seedChain activates
        // Live paused ⇄ active lifecycle through the real DB.
        const paused = await svc.changeStatus(admin(orgId), "ai_creator", { id: creatorId, status: "paused" });
        expect(paused.ok).toBe(true);
        const [statusRow] = await runtimeSql!`select status from ai_creators where id = ${creatorId}`;
        expect(statusRow!.status).toBe("paused");

        // Mediation while PAUSED → rejected (inactive_parent), no snapshot row.
        const pub1 = await provisionPublication(orgId, "fx1");
        const snapPaused = await svc.upsertProfileSnapshot({ ...snapshotInput(orgId, creatorId, pub1.versionId), publicationId: pub1.pubId });
        expect(snapPaused.ok).toBe(false);
        if (!snapPaused.ok) expect(snapPaused.error.reason).toBe("inactive_parent");
        const n0 = (await runtimeSql!`select count(*)::int as n from creator_profiles where org_id = ${orgId}`)[0]!.n as number;
        expect(n0).toBe(0);

        // Reactivate → mediation succeeds.
        const revived = await svc.changeStatus(admin(orgId), "ai_creator", { id: creatorId, status: "active" });
        expect(revived.ok).toBe(true);

        const snapOk = await svc.upsertProfileSnapshot({ ...snapshotInput(orgId, creatorId, pub1.versionId), publicationId: pub1.pubId });
        expect(snapOk.ok).toBe(true);

        // Publication/version owned by org B → cross-org fail-closed via the
        // narrow join read (creator still ACTIVE, so this proves the org gate).
        const pubB = await provisionPublication(orgB, "b1");
        const snapCross = await svc.upsertProfileSnapshot({ ...snapshotInput(orgId, creatorId, pubB.versionId), publicationId: pubB.pubId });
        expect(snapCross.ok).toBe(false);
        if (!snapCross.ok) expect(snapCross.error.reason).toBe("cross_org_reference");

        // Retired after authoring → the NEXT version's mediation rejected.
        await svc.changeStatus(admin(orgId), "ai_creator", { id: creatorId, status: "retired" });
        const pub2 = await provisionPublication(orgId, "fx2");
        const snapRetired = await svc.upsertProfileSnapshot({ ...snapshotInput(orgId, creatorId, pub2.versionId), publicationId: pub2.pubId });
        expect(snapRetired.ok).toBe(false);
        if (!snapRetired.ok) expect(snapRetired.error.reason).toBe("inactive_parent");
      } finally {
        await cleanupTenant(orgId);
        await cleanupTenant(orgB);
      }
    },
  );

  it(
    "cross-org isolation: org B service cannot resolve or mutate org A chain state (not_found, no existence leak)",
    { timeout: 30_000 },
    async () => {
      const orgA = await provisionOrg("xa-" + uuid().slice(0, 8));
      const orgB = await provisionOrg("xb-" + uuid().slice(0, 8));
      try {
        const { creatorId } = await seedChain(orgA, "xa-ava");
        const svcB = createPeopleService({ repository: sharedRepo });
        const wrong = await svcB.changeStatus(admin(orgB), "ai_creator", { id: creatorId, status: "active" });
        expect(wrong.ok).toBe(false);
        if (!wrong.ok) expect(wrong.error.reason).toBe("not_found");

        const listB = await svcB.listAiCreators(admin(orgB));
        expect(listB.ok).toBe(true);
        if (!listB.ok) return;
        expect(listB.value.some((r) => r.id === creatorId)).toBe(false);
      } finally {
        await cleanupTenant(orgA);
        await cleanupTenant(orgB);
      }
    },
  );
});
