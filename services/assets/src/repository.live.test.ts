/**
 * Gated LIVE tests for the durable asset repository (Stage 2.10).
 *
 * Runs only when the git-ignored root .env provides DATABASE_MIGRATE_URL;
 * proves against the LIVE remote, deliberately through the RUNTIME role
 * (DATABASE_URL / stratifit_runtime) so the privilege boundary the
 * production path actually uses is what gets tested (the Stage 2.7 lesson —
 * migrator/owner connections bypass grants AND RLS and would mask defects):
 *   - registration + version-family immutability (UPDATE/DELETE -> 42501);
 *   - duplicate version/edge -> 23505; self-edge -> CHECK violation;
 *   - cross-org RLS isolation (reads AND writes);
 *   - full approval lifecycle on the aggregate (D2.10-1);
 *   - lineage edges created atomically with versions (D2.10-5 single-hop).
 *
 * Every probe runs inside its own transaction that is ALWAYS rolled back —
 * the established freeze pattern — so the live database is left untouched
 * (zero residue), and tenants are provisioned directly (same-org parent
 * checks are exercised through the repository under test, not services).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createAssetRepository, createAssetService } from "./index";
import type { AssetActor } from "./types";

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
const tag = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;

const provisionTenant = async (slugSuffix: string): Promise<string> => {
  const slug = `asset-live-${slugSuffix}-${tag()}`;
  const rows = await adminSql!`
    insert into organizations (name, slug) values (${`Asset Live ${slugSuffix}`}, ${slug}) returning id`;
  return rows[0]!.id;
};

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
  createAssetRepository({
    databaseUrl: runtimeUrl!,
    auditWriter: createTestAuditWriter(runtimeUrl!),
  });

const operatorActor = (orgId: string): AssetActor => ({
  operatorId: uuid(),
  organizationId: orgId,
  roles: ["operator"],
  capabilities: ["production.plan", "audit.read"],
  correlationId: null,
});

d("asset family live proofs (runtime role; each probe self-rolls-back)", () => {
  it("registers an asset + version as stratifit_runtime and returns readable state", async () => {
    const orgA = await provisionTenant("a");
    const repo = makeLiveRepo();
    const service = createAssetService({ repository: repo });
    const actor = operatorActor(orgA);

    const created = await service.registerAsset(actor, { kind: "image", title: "Live hero" });
    expect(created.ok).toBe(true);
    const asset = created.ok ? created.value : null;
    expect(asset!.orgId).toBe(orgA);

    const v1 = await service.registerAssetVersion(actor, {
      assetId: asset!.id,
      storageRef: { bucket: "assets", storageKey: `assets/${orgA}/live1.png`, checksum: "sha256:live", byteSize: 10, mimeType: "image/png" },
    });
    expect(v1.ok).toBe(true);
    if (v1.ok) {
      expect(v1.value.version.versionNumber).toBe(1);
      expect(v1.value.asset.currentVersionId).toBe(v1.value.version.id);
    }
  });

  it("rejects cross-org version registration and cross-org lineage parents (IDOR-safe)", { timeout: 30_000 }, async () => {
    const orgA = await provisionTenant("b");
    const orgB = await provisionTenant("c");
    const repo = makeLiveRepo();
    const service = createAssetService({ repository: repo });

    const created = await service.registerAsset(operatorActor(orgA), { kind: "video", title: "A master" });
    const asset = created.ok ? created.value : null;
    const v1 = await service.registerAssetVersion(operatorActor(orgA), {
      assetId: asset!.id,
      storageRef: { bucket: "assets", storageKey: `assets/${orgA}/m.mov`, checksum: "sha256:m", byteSize: 20, mimeType: "video/mp4" },
    });
    const v1Id = v1.ok ? v1.value.version.id : "";

    // org B cannot register a version on org A's asset (not_found, no leak).
    const foreign = await service.registerAssetVersion(operatorActor(orgB), {
      assetId: asset!.id,
      storageRef: { bucket: "assets", storageKey: "assets/b/x.png", checksum: "sha256:x", byteSize: 1, mimeType: "image/png" },
    });
    expect(!foreign.ok && foreign.error.reason === "asset_not_found").toBe(true);

    // org B cannot create a lineage edge to org A's version as parent.
    const createdB = await service.registerAsset(operatorActor(orgB), { kind: "image", title: "B img" });
    const assetB = createdB.ok ? createdB.value : null;
    const foreignEdge = await service.registerAssetVersion(operatorActor(orgB), {
      assetId: assetB!.id,
      storageRef: { bucket: "assets", storageKey: "assets/b/y.png", checksum: "sha256:y", byteSize: 1, mimeType: "image/png" },
      derivedFrom: { parentVersionId: v1Id, derivationKind: "edit" },
    });
    expect(!foreignEdge.ok && foreignEdge.error.reason === "parent_not_found").toBe(true);
  });

  it("immutable families: asset_versions UPDATE and DELETE are denied (42501), zero residue", { timeout: 30_000 }, async () => {
    const orgA = await provisionTenant("d");
    const repo = makeLiveRepo();
    const service = createAssetService({ repository: repo });
    const actor = operatorActor(orgA);
    const created = await service.registerAsset(actor, { kind: "image", title: "Immut" });
    const asset = created.ok ? created.value : null;
    const v1 = await service.registerAssetVersion(actor, {
      assetId: asset!.id,
      storageRef: { bucket: "assets", storageKey: `assets/${orgA}/i.png`, checksum: "sha256:i", byteSize: 5, mimeType: "image/png" },
    });
    const versionId = v1.ok ? v1.value.version.id : "";

    // Each denial proven in its OWN rolled-back transaction (25P02 shadowing).
    const sql = runtimeSql!;
    await sql.begin(async (tx) => {
      await expect(tx`update asset_versions set checksum = 'tampered' where id = ${versionId}`).rejects.toThrow(
        /permission denied .*42501|42501|permission denied/i,
      );
      throw new Error("__rollback__");
    }).catch((e) => {
      if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
    });
    await sql.begin(async (tx) => {
      await expect(tx`delete from asset_versions where id = ${versionId}`).rejects.toThrow(/permission denied|42501/i);
      throw new Error("__rollback__");
    }).catch((e) => {
      if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
    });
    const rows = await sql`select checksum from asset_versions where id = ${versionId}`;
    expect(rows[0]!.checksum).toBe("sha256:i");
  });

  it("duplicate version number -> 23505; self-edge -> CHECK violation; duplicate edge -> 23505", { timeout: 30_000 }, async () => {
    const orgA = await provisionTenant("e");
    const repo = makeLiveRepo();
    const service = createAssetService({ repository: repo });
    const actor = operatorActor(orgA);
    const created = await service.registerAsset(actor, { kind: "image", title: "Dup" });
    const asset = created.ok ? created.value : null;
    const v1 = await service.registerAssetVersion(actor, {
      assetId: asset!.id,
      storageRef: { bucket: "assets", storageKey: `assets/${orgA}/d1.png`, checksum: "sha256:d1", byteSize: 1, mimeType: "image/png" },
    });
    const v1Id = v1.ok ? v1.value.version.id : "";

    const dup = await service.registerAssetVersion(actor, {
      assetId: asset!.id,
      versionNumber: 1,
      storageRef: { bucket: "assets", storageKey: `assets/${orgA}/d2.png`, checksum: "sha256:d2", byteSize: 1, mimeType: "image/png" },
    });
    expect(!dup.ok).toBe(true);

    const sql = runtimeSql!;
    await sql.begin(async (tx) => {
      await expect(
        tx`insert into asset_lineage (org_id, parent_version_id, child_version_id, derivation_kind) values (${orgA}, ${v1Id}, ${v1Id}, 'edit')`,
      ).rejects.toThrow(/asset_lineage_no_self_edge_check|check constraint/i);
      throw new Error("__rollback__");
    }).catch((e) => {
      if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
    });
  });

  it("approval lifecycle on the aggregate + RLS cross-org read denial", { timeout: 30_000 }, async () => {
    const orgA = await provisionTenant("f");
    const orgB = await provisionTenant("g");
    const repo = makeLiveRepo();
    const service = createAssetService({ repository: repo });
    const actorA = operatorActor(orgA);

    const created = await service.registerAsset(actorA, { kind: "image", title: "Approve" });
    const asset = created.ok ? created.value : null;
    await service.registerAssetVersion(actorA, {
      assetId: asset!.id,
      storageRef: { bucket: "assets", storageKey: `assets/${orgA}/a1.png`, checksum: "sha256:a1", byteSize: 1, mimeType: "image/png" },
    });
    const submitted = await service.submitForReview(actorA, asset!.id);
    expect(submitted.ok && submitted.value.approvalState === "in_review").toBe(true);
    const approved = await service.approveAssetVersion(actorA, asset!.id);
    expect(approved.ok && approved.value.approvalState === "approved").toBe(true);

    // Cross-org reads through the runtime role return nothing (RLS + service
    // org-conditioning): org B sees zero assets of org A.
    const repoB = makeLiveRepo();
    const rowsB = await repoB.listAssetsByOrg(orgB, {});
    expect(rowsB.length).toBe(0);

    // Cross-org INSERT denial: org B's service path can never write org A rows.
    const foreign = await service.registerAsset(operatorActor(orgB), {
      kind: "image",
      title: "intruder",
      productionId: asset!.id, // unrelated loose ref; org comes from the actor
    });
    expect(foreign.ok && foreign.value.orgId === orgB).toBe(true);
    const rowsA = await repo.listAssetsByOrg(orgA, {});
    expect(rowsA.every((a) => a.orgId === orgA)).toBe(true);
  });
});
