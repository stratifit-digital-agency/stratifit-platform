import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@stratifit/database";
import { createDrizzleProductionRepository } from "./repository";
import type { ProductionAuditAppend } from "./types";

/**
 * Live repository proof for the Stage 2.6 production family (gated on the
 * git-ignored root .env, same pattern as the other live suites). Connects as
 * the RUNTIME role via DATABASE_URL and verifies against the REAL remote:
 *   - the full command happy path persists (project -> production -> plan
 *     version -> passing gate -> approve -> manifest issuance);
 *   - unique (production, version) constraints hold;
 *   - UPDATE and DELETE on the three IMMUTABLE families are DENIED (42501 —
 *     D2.6-4 INSERT+SELECT only);
 *   - D2.4-1: a failing audit INSERT inside runInTransaction rolls back the
 *     domain mutation.
 *
 * Rows created here are tenant-scoped under a throwaway organization where
 * possible; all inserts go through the sanctioned runtime path.
 */
const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const databaseUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;

const db: Database | null = hasEnv && databaseUrl ? (await import("@stratifit/database")).createDatabase(databaseUrl) : null;
const raw = hasEnv && databaseUrl ? postgres(databaseUrl, { prepare: false, max: 1 }) : null;

const d = hasEnv && databaseUrl ? describe : describe.skip;

d("production repository (live, gated)", () => {
  const appendAudit: ProductionAuditAppend = async () => {};
  const repo = createDrizzleProductionRepository({
    db: db!,
    auditWriter: { appendWithin: async () => {} },
  });
  void appendAudit;

  const orgId = randomUUID();
  const operatorId = randomUUID();
  let projectId = "";
  let productionId = "";
  let planVersionId = "";

  const validPlan = {
    sceneCount: 1,
    shotCount: 2,
    modelSelections: [{ capability: "image.generation", modelId: "m", modelVersion: "1" }],
    workflowSelections: [{ workflowId: "wf", workflowVersion: "1" }],
    computeEstimate: {
      gpuClass: "rtx-4090",
      vramGb: 24,
      workers: 1,
      concurrency: 1,
      estimatedRuntimeSeconds: 60,
      storageMb: 128,
      estimatedCostUsd: 0.1,
    },
    rights: { digitalHumanRightsConfirmed: true, voiceRightsConfirmed: true },
    safety: { moderationRequired: false },
  };

  beforeAll(async () => {
    // A throwaway tenant keeps this suite self-contained; operator/project FKs
    // require real rows, so they are created here and removed in afterAll.
    await raw!`insert into organizations (id, slug, name) values (${orgId}, ${"live-prod-" + orgId.slice(0, 8)}, 'Live Production Test')`;
    await raw!`insert into operators (id, org_id, auth_subject_ref, email) values (${operatorId}, ${orgId}, ${"live-" + operatorId}, ${"live-" + operatorId + "@example.com"})`;
  });

  it("persists the full production happy path through the repository", async () => {
    const project = await repo.insertProject({ orgId, slug: "live-project", name: "Live Project", createdBy: operatorId });
    projectId = project.id;
    const production = await repo.insertProduction({ orgId, projectId, title: "Live Pilot", kind: "short" });
    productionId = production.id;
    expect(production.status).toBe("draft");

    const version = await repo.insertPlanVersion({ orgId, productionId, versionNumber: 1, planDocument: validPlan, createdBy: operatorId });
    planVersionId = version.id;
    const moved = await repo.updateProduction(productionId, { currentPlanVersionId: version.id, status: "planning" });
    expect(moved.status).toBe("planning");

    const gate = await repo.insertGateDecision({
      orgId,
      productionId,
      planVersionId,
      decision: "pass",
      inputsSnapshot: {},
      issues: [],
      evaluatedBy: operatorId,
    });
    expect(gate.decision).toBe("pass");

    const passing = await repo.findPassingGateDecision(productionId, planVersionId);
    expect(passing?.id).toBe(gate.id);

    const manifest = await repo.insertManifestVersion({
      orgId,
      productionId,
      planVersionId,
      versionNumber: 1,
      manifestDocument: {
        manifestVersion: "1",
        organizationId: orgId,
        productionId,
        createdAt: new Date().toISOString(),
        approvedBy: operatorId,
        sceneCount: 1,
        shotCount: 2,
        modelSelections: validPlan.modelSelections,
        workflowSelections: validPlan.workflowSelections,
        computeEstimate: validPlan.computeEstimate,
        rights: validPlan.rights,
        safety: validPlan.safety,
        plan: validPlan as unknown as Record<string, unknown>,
      },
      issuedBy: operatorId,
    });
    expect(manifest.versionNumber).toBe(1);

    const updated = await repo.updateProduction(productionId, { status: "approved", currentManifestVersionId: manifest.id });
    expect(updated.status).toBe("approved");
  });

  it("enforces unique (production, version) on immutable families", async () => {
    // Drizzle wraps driver errors: the PG code lives on `cause`.
    const error = await repo
      .insertPlanVersion({ orgId, productionId, versionNumber: 1, planDocument: validPlan, createdBy: operatorId })
      .then(
        () => null,
        (e: unknown) => e as { cause?: { code?: string } } & Error,
      );
    expect(error).not.toBeNull();
    expect((error as { cause?: { code?: string } }).cause?.code).toBe("23505");
  });

  it("DENIES UPDATE on gate_decision_records for the runtime role (42501, D2.6-4)", async () => {
    await expect(
      raw!`update gate_decision_records set decision = 'fail' where production_id = ${productionId}`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("DENIES DELETE on manifest_versions for the runtime role (42501, D2.6-4)", async () => {
    await expect(
      raw!`delete from manifest_versions where production_id = ${productionId}`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("DENIES UPDATE on production_plan_versions for the runtime role (42501, D2.6-4)", async () => {
    await expect(
      raw!`update production_plan_versions set version_number = 99 where production_id = ${productionId}`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rolls back the domain mutation when the same-transaction audit append fails (D2.4-1)", async () => {
    const failingRepo = createDrizzleProductionRepository({
      db: db!,
      auditWriter: {
        appendWithin: async () => {
          throw new Error("audit insert failed");
        },
      },
    });
    const slug = "rollback-" + randomUUID().slice(0, 8);
    await expect(
      failingRepo.runInTransaction!(async (tx) => {
        const project = await tx.insertProject({ orgId, slug, name: "Rollback", createdBy: operatorId });
        await tx.appendAudit({
          actorId: operatorId,
          action: "production.project_created",
          targetType: "project",
          targetId: project.id,
          organizationId: orgId,
        });
        return project;
      }),
    ).rejects.toThrow(/audit insert failed/);
    const survivors = await raw!`select count(*)::int as n from projects where org_id = ${orgId} and slug = ${slug}`;
    expect(survivors[0]!.n).toBe(0);
  });

  afterAll(async () => {
    // FK cascade (migration 0010): deleting the tenant removes operators,
    // projects, productions, and the dependent immutable families. Wait —
    // DELETE on the immutable families is denied for runtime; deletion is
    // performed AS THE MIGRATION ROLE via DATABASE_MIGRATE_URL when present,
    // otherwise the test rows remain (documented in the build report).
    const migrateUrl = hasEnv
      ? (readFileSync(envPath, "utf8").match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null)
      : null;
    if (migrateUrl && raw) {
      const admin = postgres(migrateUrl, { prepare: false, max: 1 });
      try {
        await admin`delete from organizations where id = ${orgId}`;
      } catch {
        // Leave rows in place if the migrator connection is unavailable;
        // documented in the build report rather than failing the suite.
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
    if (raw) await raw.end({ timeout: 1 });
  });
});
