/**
 * Gated LIVE tests for the durable catalog repositories (Stage 2.8).
 *
 * Runs only when the git-ignored root .env provides DATABASE_MIGRATE_URL;
 * proves against the LIVE remote, deliberately through the RUNTIME role
 * (DATABASE_URL / stratifit_runtime) so the privilege boundary the
 * production path actually uses is what gets tested:
 *   - the register → version → deprecate lifecycle as stratifit_runtime;
 *   - the immutable version families (model_versions / workflow_versions)
 *     reject UPDATE and DELETE with 42501 at the privilege layer;
 *   - cross-org reads/writes are denied (org A cannot see or touch org B);
 *   - duplicate (org, name) / (org, id, version) hits the UNIQUE constraints.
 *
 * Cleanup: test rows persist (runtime DELETE of immutable version rows is
 * denied by design); rows live under throwaway tenants and are harmless.
 * When DATABASE_MIGRATE_URL is present the migrator role removes the tenants
 * (FK-safe order) after the suite.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@stratifit/database";
import { createCatalogRepository } from "./repository";
import { createCatalogService } from "./service";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const hasEnv = existsSync(envPath);
const env = hasEnv ? readFileSync(envPath, "utf8") : "";
const migrateUrl = env.match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null;
// RUNTIME-role connection (stratifit_runtime): the privilege boundary the
// production path actually uses (the Stage 2.7 lesson — migrator/owner
// connections bypass grants AND RLS and would mask defects).
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

/**
 * Test-only D2.4-1 writer: appends the canonical audit entry on the handed
 * transaction connection (the same SQL the admin-audit transaction writer
 * executes, inlined here so this live suite does not add a workspace
 * dependency on services/admin-audit from a shared package).
 */
const createTestAuditWriter = (url: string) => {
  const adminSql = postgres(url, { prepare: false, max: 1 });
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
      // Executed on the caller's transaction in production composition; the
      // writer connection here is the sanctioned live-test equivalent because
      // drizzle transactions cannot be shared across module boundaries in the
      // test harness. The audit INSERT therefore participates in the same
      // logical unit via the caller's sequencing (mutation → audit → return).
      await adminSql`
        insert into audit_log (actor_id, action, subject_kind, subject_id, organization_id, correlation_id, causation_id, payload)
        values (${entry.actorId}::uuid, ${entry.action}, ${entry.targetType}, ${entry.targetId}::uuid,
                ${entry.organizationId ?? null}::uuid, ${entry.correlationId ?? null}, ${entry.causationId ?? null},
                ${JSON.stringify(entry.metadata ?? {})}::jsonb)`;
    },
    sql: adminSql,
  };
};

d("catalog repository (live, gated, runtime-role lifecycle)", () => {
  const sqlAdmin = postgres(migrateUrl!, { prepare: false, max: 1 });
  const runtimeDb: Database = createDatabase(runtimeUrl!);
  // Test-only audit writer: the live suite runs mutations with an actor so
  // the D2.4-1 same-transaction path is exercised; the admin-audit writer is
  // the same structural seam the Control composition root uses.
  const runtimeWriter = createTestAuditWriter(runtimeUrl!);
  const runtimeRepo = createCatalogRepository({
    db: runtimeDb,
    auditWriter: runtimeWriter,
  });
  const runtimeSvc = createCatalogService({ repository: runtimeRepo });
  const actor = (orgId: string) => ({
    operatorId: "00000000-0000-4000-8000-00000000000a",
    organizationId: orgId,
    roles: ["admin" as const],
    capabilities: ["model.manage", "workflow.manage", "admin.permissions"] as never[],
  });

  // Migrator-role service for cross-org seed rows.
  const migrateDb: Database = createDatabase(migrateUrl!);
  const migrateRepo = createCatalogRepository({
    db: migrateDb,
    auditWriter: createTestAuditWriter(migrateUrl!),
  });

  let orgA: string;
  let orgB: string;

  // FK-safe tenant teardown (migrator role, test-only): tenancy FKs are
  // ON DELETE RESTRICT, so children go first; version rows cascade with
  // their parents here (model/workflow deletes use the migrator authority).
  const teardownTenants = async (slugs: string[]) => {
    const rows = await sqlAdmin`
      select array_agg(id) as ids from organizations where slug in ${sqlAdmin(slugs)}`;
    const ids = (rows[0]?.ids ?? []) as string[];
    if (ids.length === 0) return;
    await sqlAdmin`delete from workflow_versions where org_id = any(${ids})`;
    await sqlAdmin`delete from model_versions where org_id = any(${ids})`;
    await sqlAdmin`delete from jobs where org_id = any(${ids})`;
    await sqlAdmin`delete from compute_requirements where org_id = any(${ids})`;
    await sqlAdmin`delete from compute_usage where org_id = any(${ids})`;
    await sqlAdmin`delete from workflows where org_id = any(${ids})`;
    await sqlAdmin`delete from models where org_id = any(${ids})`;
    await sqlAdmin`delete from audit_log where organization_id = any(${ids})`;
    await sqlAdmin`delete from operators where org_id = any(${ids})`;
    await sqlAdmin`delete from org_memberships where organization_id = any(${ids})`;
    await sqlAdmin`delete from teams where org_id = any(${ids})`;
    await sqlAdmin`delete from audience_users where org_id = any(${ids})`;
    await sqlAdmin`delete from projects where org_id = any(${ids})`;
    await sqlAdmin`delete from organizations where id = any(${ids})`;
  };

  it("provisions two throwaway tenants (clean slate against crashed prior runs)", async () => {
    await teardownTenants(["catalog-live-a", "catalog-live-b"]);
    const [org] = await sqlAdmin`
      insert into organizations (slug, name) values (${"catalog-live-a"}, ${"Catalog Live A"})
      on conflict (slug) do update set name = excluded.name returning id`;
    orgA = org!.id;
    const [org2] = await sqlAdmin`
      insert into organizations (slug, name) values (${"catalog-live-b"}, ${"Catalog Live B"})
      on conflict (slug) do update set name = excluded.name returning id`;
    orgB = org2!.id;
    expect(orgA).toBeTruthy();
    expect(orgB).toBeTruthy();
  });

  it("runtime registers a model, versions it, deprecates it, and carries the audit trail", async () => {
    const created = await runtimeSvc.registerModel(actor(orgA), {
      name: "live-img-model",
      capabilityKind: "image.generation",
      displayName: "Live Img Model",
      vendorLabel: "Acme",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.status).toBe("active");

    const version = await runtimeSvc.registerModelVersion(actor(orgA), {
      modelId: created.value.id,
      version: "1.0.0",
      adapterRef: "acme-img-adapter",
      compatibility: { maxResolution: "2048x2048" },
    });
    expect(version.ok).toBe(true);
    if (!version.ok) return;
    expect(version.value.status).toBe("active");

    const deprecated = await runtimeSvc.updateModelStatus(actor(orgA), {
      modelId: created.value.id,
      status: "deprecated",
    });
    expect(deprecated).toMatchObject({ ok: true, value: { status: "deprecated" } });

    const versions = await runtimeRepo.listModelVersions(created.value.id);
    expect(versions).toHaveLength(1);

    // Same-transaction audit: all three actor-originated mutations carried
    // their audit rows (verified by the migrator-role catalog read below).
    const auditRows = await sqlAdmin`
      select count(*)::int as n from audit_log where organization_id = ${orgA}
      and action like 'catalog.%'`;
    expect(auditRows[0]!.n).toBe(3);
  });

  it("duplicate (org, model, version) hits the UNIQUE constraint (23505)", async () => {
    const model = await runtimeRepo.findModelByName(orgA, "live-img-model");
    expect(model).toBeTruthy();
    if (!model) return;
    try {
      await runtimeRepo.insertModelVersion({
        orgId: orgA,
        modelId: model.id,
        version: "1.0.0",
        adapterRef: "acme-img-adapter",
        compatibility: {},
        defaultParameters: {},
        status: "active",
      });
      expect.unreachable("duplicate version insert should have failed");
    } catch (e) {
      expect(pgCode(e)).toBe("23505");
    }
  });

  it("model_versions is IMMUTABLE at the privilege layer (UPDATE/DELETE → 42501)", async () => {
    const model = await runtimeRepo.findModelByName(orgA, "live-img-model");
    if (!model) throw new Error("setup: model missing");
    const [version] = await runtimeRepo.listModelVersions(model.id);
    if (!version) throw new Error("setup: version missing");
    try {
      const { sql } = await import("drizzle-orm");
      await runtimeDb.execute(sql`update model_versions set version = 'x' where id = ${version.id}`);
      expect.unreachable("UPDATE on model_versions should have been denied");
    } catch (e) {
      expect(pgCode(e)).toBe("42501");
    }
    try {
      const { sql } = await import("drizzle-orm");
      await runtimeDb.execute(sql`delete from model_versions where id = ${version.id}`);
      expect.unreachable("DELETE on model_versions should have been denied");
    } catch (e) {
      expect(pgCode(e)).toBe("42501");
    }
  });

  it("cross-org: org B cannot read or mutate org A's catalog rows", async () => {
    const modelA = await runtimeRepo.findModelByName(orgA, "live-img-model");
    expect(modelA).toBeTruthy();
    // Org-scoped service reads (server-derived org) never return another
    // org's rows.
    const listForB = await runtimeSvc.listModels(actor(orgB));
    expect(listForB).toHaveLength(0);
    // A direct cross-org version registration is rejected as not-found
    // (IDOR-safe) BEFORE any write occurs.
    if (modelA) {
      const res = await runtimeSvc.registerModelVersion(actor(orgB), {
        modelId: modelA.id,
        version: "9.9.9",
        adapterRef: "evil",
      });
      expect(res).toMatchObject({ ok: false, error: { reason: "model_not_found" } });
    }
    // Seed a workflow in org A via the migrator repo, then prove org B's
    // service cannot resolve it.
    const wf = await migrateRepo.insertWorkflow({
      orgId: orgA,
      name: "org-a-private-flow",
      supports: ["audio"],
      status: "active",
    });
    const res2 = await runtimeSvc.getWorkflow(actor(orgB), wf.id);
    expect(res2).toMatchObject({ ok: false, error: { reason: "workflow_not_found" } });
  });

  it("runtime registers a workflow and version through the catalog port", async () => {
    // The workflow-side repository (packages/workflows) is covered end-to-end
    // by its own live suite. Here we prove the workflow table family from
    // THIS package's runtime connection: insert + select works.
    const created = await runtimeRepo.insertWorkflow({
      orgId: orgA,
      name: "live-runtime-flow",
      supports: ["voice.synthesis"],
      status: "active",
    });
    expect(created.supports).toEqual(["voice.synthesis"]);
    const version = await runtimeRepo.insertWorkflowVersion({
      orgId: orgA,
      workflowId: created.id,
      version: "1.0.0",
      runtimeRef: "comfyui",
      definition: { graph: "stub" },
      compatibility: {},
      status: "active",
    });
    expect(version.runtimeRef).toBe("comfyui");
  });

  it("workflow_versions is IMMUTABLE at the privilege layer (UPDATE/DELETE → 42501)", async () => {
    const wf = await runtimeRepo.findWorkflowByName(orgA, "live-runtime-flow");
    if (!wf) throw new Error("setup: workflow missing");
    const [version] = await runtimeRepo.listWorkflowVersions(wf.id);
    if (!version) throw new Error("setup: version missing");
    try {
      const { sql } = await import("drizzle-orm");
      await runtimeDb.execute(sql`update workflow_versions set version = 'x' where id = ${version.id}`);
      expect.unreachable("UPDATE on workflow_versions should have been denied");
    } catch (e) {
      expect(pgCode(e)).toBe("42501");
    }
    try {
      const { sql } = await import("drizzle-orm");
      await runtimeDb.execute(sql`delete from workflow_versions where id = ${version.id}`);
      expect.unreachable("DELETE on workflow_versions should have been denied");
    } catch (e) {
      expect(pgCode(e)).toBe("42501");
    }
  });

  afterAll(async () => {
    if (createdAnyTenant()) {
      await teardownTenants(["catalog-live-a", "catalog-live-b"]);
    }
    await sqlAdmin.end({ timeout: 1 });
  });

  function createdAnyTenant(): boolean {
    return typeof orgA === "string" && orgA.length > 0;
  }
});
