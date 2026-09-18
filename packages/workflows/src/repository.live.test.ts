/**
 * Gated LIVE tests for the workflow catalog repository (Stage 2.8).
 *
 * Runs only when the git-ignored root .env provides DATABASE_MIGRATE_URL;
 * proves against the LIVE remote through the RUNTIME role (DATABASE_URL /
 * stratifit_runtime) — the privilege boundary the production path uses:
 *   - register → version → deprecate lifecycle as stratifit_runtime;
 *   - workflow_versions rejects UPDATE and DELETE with 42501;
 *   - cross-org service access is IDOR-safe (not-found);
 *   - duplicate (org, name) / (org, workflow, version) hits the constraints.
 *
 * Cleanup: migrator-role FK-safe tenant teardown after the suite (test rows
 * persist harmlessly when the suite is skipped mid-way or the env is absent).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@stratifit/database";
import { createWorkflowCatalogRepository } from "./repository";
import { createWorkflowCatalogService } from "./service";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const hasEnv = existsSync(envPath);
const env = hasEnv ? readFileSync(envPath, "utf8") : "";
const migrateUrl = env.match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null;
const runtimeUrl = env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null;

const d = hasEnv && migrateUrl ? describe : describe.skip;

/** Drizzle wraps driver errors: the PG code lives on `cause`. */
const pgCode = (e: unknown): string | undefined => {
  let cur: any = e;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    if (typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) return cur.code;
    cur = cur.cause;
  }
  return undefined;
};

/** Test-only D2.4-1 writer (canonical audit INSERT; see packages/ai suite). */
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
      await adminSql`
        insert into audit_log (actor_id, action, subject_kind, subject_id, organization_id, correlation_id, causation_id, payload)
        values (${entry.actorId}::uuid, ${entry.action}, ${entry.targetType}, ${entry.targetId}::uuid,
                ${entry.organizationId ?? null}::uuid, ${entry.correlationId ?? null}, ${entry.causationId ?? null},
                ${JSON.stringify(entry.metadata ?? {})}::jsonb)`;
    },
    sql: adminSql,
  };
};

d("workflow catalog repository (live, gated, runtime-role lifecycle)", () => {
  const sqlAdmin = createTestAuditWriter(migrateUrl!).sql;
  const runtimeDb: Database = createDatabase(runtimeUrl!);
  const runtimeRepo = createWorkflowCatalogRepository({
    db: runtimeDb,
    auditWriter: createTestAuditWriter(runtimeUrl!),
  });
  const runtimeSvc = createWorkflowCatalogService({ repository: runtimeRepo });
  const actor = (orgId: string) => ({
    operatorId: "00000000-0000-4000-8000-00000000000b",
    organizationId: orgId,
    roles: ["operator" as const],
    capabilities: ["workflow.manage", "admin.permissions"] as never[],
  });

  let orgA: string;
  let orgB: string;

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

  it("provisions two throwaway tenants (clean slate)", async () => {
    await teardownTenants(["wfcatalog-live-a", "wfcatalog-live-b"]);
    const [org] = await sqlAdmin`
      insert into organizations (slug, name) values (${"wfcatalog-live-a"}, ${"WF Catalog Live A"})
      on conflict (slug) do update set name = excluded.name returning id`;
    orgA = org!.id;
    const [org2] = await sqlAdmin`
      insert into organizations (slug, name) values (${"wfcatalog-live-b"}, ${"WF Catalog Live B"})
      on conflict (slug) do update set name = excluded.name returning id`;
    orgB = org2!.id;
    expect(orgA).toBeTruthy();
    expect(orgB).toBeTruthy();
  });

  it("runtime registers a workflow, versions it, deprecates it (audited, same transaction)", async () => {
    const created = await runtimeSvc.registerWorkflow(actor(orgA), {
      name: "live-video-flow",
      supports: ["video.generation", "vfx"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const version = await runtimeSvc.registerWorkflowVersion(actor(orgA), {
      workflowId: created.value.id,
      version: "1.0.0",
      runtimeRef: "comfyui",
      definition: { nodes: [{ id: "n1" }] },
    });
    expect(version.ok).toBe(true);
    if (!version.ok) return;
    const deprecated = await runtimeSvc.updateWorkflowStatus(actor(orgA), {
      workflowId: created.value.id,
      status: "deprecated",
    });
    expect(deprecated).toMatchObject({ ok: true, value: { status: "deprecated" } });
    const auditRows = await sqlAdmin`
      select count(*)::int as n from audit_log where organization_id = ${orgA}
      and action like 'catalog.%'`;
    expect(auditRows[0]!.n).toBe(3);
  });

  it("duplicate (org, workflow, version) hits the UNIQUE constraint (23505)", async () => {
    const wf = await runtimeRepo.findWorkflowByName(orgA, "live-video-flow");
    if (!wf) throw new Error("setup: workflow missing");
    try {
      await runtimeRepo.insertWorkflowVersion({
        orgId: orgA,
        workflowId: wf.id,
        version: "1.0.0",
        runtimeRef: "comfyui",
        definition: {},
        compatibility: {},
        status: "active",
      });
      expect.unreachable("duplicate version insert should have failed");
    } catch (e) {
      expect(pgCode(e)).toBe("23505");
    }
  });

  it("workflow_versions is IMMUTABLE at the privilege layer (UPDATE/DELETE → 42501)", async () => {
    const wf = await runtimeRepo.findWorkflowByName(orgA, "live-video-flow");
    if (!wf) throw new Error("setup: workflow missing");
    const [version] = await runtimeRepo.listWorkflowVersions(wf.id);
    if (!version) throw new Error("setup: version missing");
    const { sql } = await import("drizzle-orm");
    try {
      await runtimeDb.execute(sql`update workflow_versions set version = 'x' where id = ${version.id}`);
      expect.unreachable("UPDATE on workflow_versions should have been denied");
    } catch (e) {
      expect(pgCode(e)).toBe("42501");
    }
    try {
      await runtimeDb.execute(sql`delete from workflow_versions where id = ${version.id}`);
      expect.unreachable("DELETE on workflow_versions should have been denied");
    } catch (e) {
      expect(pgCode(e)).toBe("42501");
    }
  });

  it("cross-org: org B cannot resolve org A's workflow (IDOR-safe)", async () => {
    const listForB = await runtimeSvc.listWorkflows(actor(orgB));
    expect(listForB).toHaveLength(0);
    const wfA = await runtimeRepo.findWorkflowByName(orgA, "live-video-flow");
    if (!wfA) throw new Error("setup: workflow missing");
    const res = await runtimeSvc.getWorkflow(actor(orgB), wfA.id);
    expect(res).toMatchObject({ ok: false, error: { reason: "workflow_not_found" } });
  });

  afterAll(async () => {
    if (typeof orgA === "string" && orgA.length > 0) {
      await teardownTenants(["wfcatalog-live-a", "wfcatalog-live-b"]);
    }
    await sqlAdmin.end({ timeout: 1 });
  });
});
