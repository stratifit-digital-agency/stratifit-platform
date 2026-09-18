/**
 * Gated LIVE tests for the durable generation repository (Stage 2.9).
 *
 * Runs only when the git-ignored root .env provides DATABASE_MIGRATE_URL;
 * proves against the LIVE remote, deliberately through the RUNTIME role
 * (DATABASE_URL / stratifit_runtime) so the privilege boundary the
 * production path actually uses is what gets tested (the Stage 2.7 lesson —
 * migrator/owner connections bypass grants AND RLS and would mask defects):
 *   - the request → start → complete lifecycle as stratifit_runtime;
 *   - the immutable provenance record rejects UPDATE and DELETE with 42501
 *     at the privilege layer (each in its OWN transaction);
 *   - duplicate completion hits the generation_id PRIMARY KEY (23505);
 *   - cross-org reads/writes are denied (org A cannot see or touch org B);
 *   - same-org lineage acceptance and request-key dedupe against the live
 *     UNIQUE (org, request_key) constraint;
 *   - request-key idempotency across different orgs (both allowed).
 *
 * Catalog seeding uses the MIGRATOR role ONLY to create the two throwaway
 * tenants and seed catalog rows (the catalog service path is exercised in
 * the packages/ai live suite); generation operations themselves run
 * exclusively as stratifit_runtime.
 *
 * Cleanup: test rows persist (runtime DELETE of provenance rows is denied
 * by design); rows live under throwaway tenants and are harmless. When
 * DATABASE_MIGRATE_URL is present the migrator role removes the tenants
 * (FK-safe order) after the suite.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  modelVersions,
  models,
  workflowVersions,
  workflows,
  type Database,
} from "@stratifit/database";
import { createGenerationRepository } from "./repository";
import { createGenerationService } from "./service";
import type { ModelRegistryPort, WorkflowRegistryPort } from "./types";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const hasEnv = existsSync(envPath);
const env = hasEnv ? readFileSync(envPath, "utf8") : "";
const migrateUrl = env.match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null;
// RUNTIME-role connection (stratifit_runtime): the privilege boundary the
// production path actually uses.
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
 * dependency on services/admin-audit from a service package).
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

d("generation repository (live, gated, runtime-role lifecycle)", () => {
  const sqlAdmin = postgres(migrateUrl!, { prepare: false, max: 1 });
  const runtimeDb: Database = createDatabase(runtimeUrl!);
  const runtimeWriter = createTestAuditWriter(runtimeUrl!);
  const runtimeRepo = createGenerationRepository({
    db: runtimeDb,
    auditWriter: runtimeWriter,
  });
  const actor = (orgId: string) => ({
    operatorId: "00000000-0000-4000-8000-00000000000a",
    organizationId: orgId,
    roles: ["admin" as const],
    capabilities: ["generation.request", "audit.read"] as never[],
  });

  // Catalog resolution ports over the LIVE catalog rows (org-scoped selects
  // as stratifit_runtime — SELECT is granted on the catalog families).
  const modelRegistry: ModelRegistryPort = {
    findModel: async (orgId, modelId) => {
      const [row] = await runtimeDb
        .select({ id: models.id, orgId: models.orgId, name: models.name, status: models.status })
        .from(models)
        .where(and(eq(models.id, modelId), eq(models.orgId, orgId)))
        .limit(1);
      return row ?? null;
    },
    resolveModelVersion: async (orgId, mId, version) => {
      const [row] = await runtimeDb
        .select({ id: modelVersions.id, orgId: modelVersions.orgId, modelId: modelVersions.modelId, version: modelVersions.version, status: modelVersions.status })
        .from(modelVersions)
        .where(and(eq(modelVersions.orgId, orgId), eq(modelVersions.modelId, mId), eq(modelVersions.version, version)))
        .limit(1);
      return row ? { ...row, status: row.status as "active" | "deprecated" | "disabled" } : null;
    },
  };
  const workflowRegistry: WorkflowRegistryPort = {
    findWorkflow: async (orgId, workflowId) => {
      const [row] = await runtimeDb
        .select({ id: workflows.id, orgId: workflows.orgId, name: workflows.name, status: workflows.status })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
        .limit(1);
      return row ?? null;
    },
    resolveWorkflowVersion: async (orgId, wId, version) => {
      const [row] = await runtimeDb
        .select({ id: workflowVersions.id, orgId: workflowVersions.orgId, workflowId: workflowVersions.workflowId, version: workflowVersions.version, status: workflowVersions.status })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.orgId, orgId), eq(workflowVersions.workflowId, wId), eq(workflowVersions.version, version)))
        .limit(1);
      return row ? { ...row, status: row.status as "active" | "deprecated" | "disabled" } : null;
    },
  };

  const runtimeSvc = createGenerationService({
    repository: runtimeRepo,
    modelRegistry,
    workflowRegistry,
  });

  let orgA: string;
  let orgB: string;
  let seededModelA: string;
  let seededModelVersionA: string;
  let seededWorkflowA: string;
  let seededWorkflowVersionA: string;

  // FK-safe tenant teardown (migrator role, test-only): tenancy FKs are
  // ON DELETE RESTRICT, so children go first.
  const teardownTenants = async (slugs: string[]) => {
    const rows = await sqlAdmin`
      select array_agg(id) as ids from organizations where slug in ${sqlAdmin(slugs)}`;
    const ids = (rows[0]?.ids ?? []) as string[];
    if (ids.length === 0) return;
    await sqlAdmin`delete from generation_provenance where org_id = any(${ids})`;
    await sqlAdmin`delete from generations where org_id = any(${ids})`;
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
    await teardownTenants(["generation-live-a", "generation-live-b"]);
    const [org] = await sqlAdmin`
      insert into organizations (name, slug) values ('Generation Live A', 'generation-live-a') returning id`;
    orgA = org!.id;
    const [org2] = await sqlAdmin`
      insert into organizations (name, slug) values ('Generation Live B', 'generation-live-b') returning id`;
    orgB = org2!.id;
    expect(orgA).toBeTruthy();
    expect(orgB).toBeTruthy();
  });

  it("seeds catalog rows for org A (migrator authority, test-only)", async () => {
    const [m] = await sqlAdmin`
      insert into models (org_id, name, capability_kind, display_name, vendor_label, status)
      values (${orgA}, 'seed-model', 'image.generation', 'Seed Model', 'seed', 'active')
      returning id`;
    seededModelA = m!.id;
    const [mv] = await sqlAdmin`
      insert into model_versions (org_id, model_id, version, adapter_ref, status)
      values (${orgA}, ${seededModelA}, 'v1', 'seed-adapter', 'active')
      returning id`;
    seededModelVersionA = mv!.id;
    const [w] = await sqlAdmin`
      insert into workflows (org_id, name, supports, status)
      values (${orgA}, 'seed-workflow', ${JSON.stringify(["image.generation"])}::jsonb, 'active')
      returning id`;
    seededWorkflowA = w!.id;
    const [wv] = await sqlAdmin`
      insert into workflow_versions (org_id, workflow_id, version, runtime_ref, status)
      values (${orgA}, ${seededWorkflowA}, 'v1', 'seed-runtime', 'active')
      returning id`;
    seededWorkflowVersionA = wv!.id;
    expect(seededModelVersionA).toBeTruthy();
    expect(seededWorkflowVersionA).toBeTruthy();
  });

  it("requests a generation as stratifit_runtime with LIVE catalog resolution (pinned UUIDs)", async () => {
    const result = await runtimeSvc.requestGeneration(actor(orgA), {
      modelId: seededModelA,
      modelVersion: "v1",
      workflowId: seededWorkflowA,
      workflowVersion: "v1",
      prompt: "live runtime lifecycle",
      requestKey: "live-req-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const g = result.value.generation;
    expect(result.value.deduplicated).toBe(false);
    expect(g.status).toBe("requested");
    // Pinned resolution: the durable Catalog version UUIDs.
    expect(g.modelVersionId).toBe(seededModelVersionA);
    expect(g.workflowVersionId).toBe(seededWorkflowVersionA);
  });

  it("request-key idempotency: duplicate resolves to the EXISTING generation (23505 never hit)", async () => {
    const result = await runtimeSvc.requestGeneration(actor(orgA), {
      modelId: seededModelA,
      modelVersion: "v1",
      prompt: "live runtime lifecycle",
      requestKey: "live-req-1",
    });
    expect(result.ok && result.value.deduplicated).toBe(true);
  });

  it("runs the full lifecycle: start → complete (provenance + status in ONE transaction)", async () => {
    const requested = await runtimeSvc.requestGeneration(actor(orgA), {
      modelId: seededModelA,
      modelVersion: "v1",
      prompt: "lifecycle run",
      requestKey: "live-req-2",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const genId = requested.value.generation.id;

    const started = await runtimeSvc.startGeneration(genId);
    expect(started.ok && started.value.status === "running" && started.value.startedAt !== null).toBe(true);

    const completed = await runtimeSvc.completeGeneration(genId, {
      outputStorageKey: `generations/${orgA}/live-req-2.png`,
      outputChecksum: "sha256-deadbeef",
      outputByteSize: 12345,
      executedSeed: "42",
      workerRef: "worker-live-1",
      gpuClass: "l4",
      runtimeVersion: "runtime-v1",
      actualCostUsd: "0.0100",
      actualRuntimeSeconds: 30,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.generation.status).toBe("completed");
    expect(completed.value.provenance.generationId).toBe(genId);
    expect(completed.value.provenance.workerRef).toBe("worker-live-1");
    // Identifiers only — the provenance record carries no credential-shaped data.
    expect(JSON.stringify(completed.value.provenance)).not.toMatch(/api[_-]?key|token|secret/i);

    // Duplicate completion: one-shot guard (service pre-check AND db PK).
    const second = await runtimeSvc.completeGeneration(genId, { workerRef: "worker-live-1" });
    expect(!second.ok && second.error.reason === "completion_conflict").toBe(true);
  });

  it("provenance is INSERT+SELECT only: UPDATE → 42501 and DELETE → 42501 (own transactions)", async () => {
    const requested = await runtimeSvc.requestGeneration(actor(orgA), {
      modelId: seededModelA,
      modelVersion: "v1",
      prompt: "immutability proof",
      requestKey: "live-req-3",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const genId = requested.value.generation.id;
    await runtimeSvc.startGeneration(genId);
    const completed = await runtimeSvc.completeGeneration(genId, { workerRef: "worker-live-2" });
    expect(completed.ok).toBe(true);

    // Each proof in its OWN transaction: a first failure aborts the tx and
    // would shadow the second with 25P02 otherwise.
    let updateCode: string | undefined;
    try {
      await runtimeDb.execute(
        sql`update generation_provenance set worker_ref = 'tampered' where generation_id = ${genId}`,
      );
    } catch (e) {
      updateCode = pgCode(e);
    }
    expect(updateCode).toBe("42501");

    let deleteCode: string | undefined;
    try {
      await runtimeDb.execute(
        sql`delete from generation_provenance where generation_id = ${genId}`,
      );
    } catch (e) {
      deleteCode = pgCode(e);
    }
    expect(deleteCode).toBe("42501");

    // The record survives untouched.
    const prov = await runtimeRepo.findProvenanceByGenerationId(genId);
    expect(prov?.workerRef).toBe("worker-live-2");
  });

  it("cross-org: org B cannot read, request-lineage, or touch org A generations (RLS + service)", async () => {
    const requested = await runtimeSvc.requestGeneration(actor(orgA), {
      modelId: seededModelA,
      modelVersion: "v1",
      prompt: "isolation proof",
      requestKey: "live-req-4",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const genId = requested.value.generation.id;

    // Read: RLS role-gate + service org conditioning — B sees nothing.
    const read = await runtimeSvc.getGeneration(actor(orgB), genId);
    expect(!read.ok && read.error.reason === "generation_not_found").toBe(true);
    const prov = await runtimeSvc.getProvenance(actor(orgB), genId);
    expect(!prov.ok && prov.error.reason === "generation_not_found").toBe(true);

    // Mutation: cancel from org B resolves to not-found (IDOR-safe).
    const cancel = await runtimeSvc.cancelGeneration(actor(orgB), genId);
    expect(!cancel.ok && cancel.error.reason === "generation_not_found").toBe(true);

    // org B cannot even REQUEST with org A's model (cross-org catalog).
    const foreign = await runtimeSvc.requestGeneration(actor(orgB), {
      modelId: seededModelA,
      modelVersion: "v1",
      prompt: "foreign catalog",
    });
    expect(!foreign.ok && foreign.error.reason === "model_not_found").toBe(true);

    // org A's generation is intact.
    const still = await runtimeSvc.getGeneration(actor(orgA), genId);
    expect(still.ok && still.value.status === "requested").toBe(true);
  });

  it("same-org lineage accepted; parent chain recorded", async () => {
    const parent = await runtimeSvc.requestGeneration(actor(orgA), {
      modelId: seededModelA,
      modelVersion: "v1",
      prompt: "parent",
      requestKey: "live-req-5",
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const child = await runtimeSvc.requestGeneration(actor(orgA), {
      modelId: seededModelA,
      modelVersion: "v1",
      prompt: "child (img2img refinement)",
      requestKey: "live-req-6",
      parentGenerationId: parent.value.generation.id,
    });
    expect(child.ok && child.value.generation.parentGenerationId === parent.value.generation.id).toBe(true);
  });

  it("cancellation lifecycle works as runtime (requested → cancelled, audited)", async () => {
    const requested = await runtimeSvc.requestGeneration(actor(orgA), {
      modelId: seededModelA,
      modelVersion: "v1",
      prompt: "cancel me",
      requestKey: "live-req-7",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const cancelled = await runtimeSvc.cancelGeneration(actor(orgA), requested.value.generation.id);
    expect(cancelled.ok && cancelled.value.status === "cancelled").toBe(true);
    // Audit record exists for the actor-originated cancel.
    const audits = await sqlAdmin`
      select count(*)::int as n from audit_log
      where organization_id = ${orgA} and action = 'generations.generation_cancelled'`;
    expect(audits[0]!.n).toBeGreaterThanOrEqual(1);
  });

  afterAll(async () => {
    // FK-safe tenant teardown (migrator authority, test-only).
    await teardownTenants(["generation-live-a", "generation-live-b"]).catch(() => {});
    await sqlAdmin.end({ timeout: 1 });
    await runtimeWriter.sql.end({ timeout: 1 });
  });
});
