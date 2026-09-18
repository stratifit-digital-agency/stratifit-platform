/**
 * Unit tests for the durable catalog service (Stage 2.8).
 *
 * Covers: capability gating (`model.manage` / `workflow.manage`), org-boundary
 * (cross-org targets IDOR-safe), duplicate name/version conflicts, status
 * transition guard, version registration semantics (inherited status for
 * deprecated parents), and the D2.4-1 same-transaction audit behavior
 * (committed mutation always carries its audit record; audit failure rolls
 * back the mutation; sequential fallback fail-closed without the test-only
 * flag).
 */
import { describe, expect, it, vi } from "vitest";
import type {
  CatalogActor,
  CatalogRepository,
  CatalogTransaction,
  ModelRecord,
  ModelRegistryStatus,
  ModelVersionRecord,
} from "./types";
import { createCatalogService } from "./service";

const actor = (over: Partial<CatalogActor> = {}): CatalogActor => ({
  operatorId: "op-1",
  organizationId: "11111111-1111-4111-8111-111111111111",
  roles: ["admin"],
  capabilities: ["model.manage", "workflow.manage", "admin.permissions"],
  ...over,
});

const model = (over: Partial<ModelRecord> = {}): ModelRecord => ({
  id: "22222222-2222-4222-8222-222222222222",
  orgId: "11111111-1111-4111-8111-111111111111",
  name: "img-core",
  capabilityKind: "image.generation",
  displayName: "Img Core",
  vendorLabel: "Acme",
  status: "active",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...over,
});  /**
   * In-memory fake with D2.4-1 transaction support and audit recording. The
   * mutation state is committed only after the audit append succeeds —
   * mirroring a real transaction where the audit failure aborts the commit.
   */
  const makeRepo = () => {
  const auditLog: { action: string; targetId: string }[] = [];
  const auditShouldFail = { value: false };
  const state = {
    models: new Map<string, ModelRecord>(),
    modelVersions: [] as ModelVersionRecord[],
  };
  const mutations = (exec: { inTx: boolean }): CatalogTransaction => ({
    insertModel: async (input) => {
      const row = model({ ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      state.models.set(row.id, row);
      return row;
    },
    updateModelStatus: async (modelId, status) => {
      const row = state.models.get(modelId);
      if (!row) throw new Error("no row");
      const updated = { ...row, status, updatedAt: new Date().toISOString() };
      state.models.set(modelId, updated);
      return updated;
    },
    insertModelVersion: async (input) => {
      const row: ModelVersionRecord = {
        id: crypto.randomUUID(),
        orgId: input.orgId,
        modelId: input.modelId,
        version: input.version,
        adapterRef: input.adapterRef,
        compatibility: input.compatibility,
        defaultParameters: input.defaultParameters,
        status: input.status as ModelRegistryStatus,
        registeredAt: new Date().toISOString(),
      };
      state.modelVersions.push(row);
      return row;
    },
    insertWorkflow: async () => {
      throw new Error("not used in this fake");
    },
    updateWorkflowStatus: async () => {
      throw new Error("not used in this fake");
    },
    insertWorkflowVersion: async () => {
      throw new Error("not used in this fake");
    },
    appendAudit: async (entry) => {
      if (auditShouldFail.value) throw new Error("audit write failed");
      auditLog.push({ action: entry.action, targetId: entry.targetId });
    },
  });
  const repo: CatalogRepository & { auditLog: typeof auditLog; auditShouldFail: typeof auditShouldFail; state: typeof state } = {
    findModelById: async (id) => state.models.get(id) ?? null,
    findModelByName: async (orgId, name) =>
      [...state.models.values()].find((m) => m.orgId === orgId && m.name === name) ?? null,
    listModelsByOrg: async (orgId) => [...state.models.values()].filter((m) => m.orgId === orgId),
    findModelVersion: async (orgId, modelId, version) =>
      state.modelVersions.find((v) => v.orgId === orgId && v.modelId === modelId && v.version === version) ?? null,
    listModelVersions: async (modelId) => state.modelVersions.filter((v) => v.modelId === modelId),
    findWorkflowById: async () => null,
    findWorkflowByName: async () => null,
    listWorkflowsByOrg: async () => [],
    findWorkflowVersion: async () => null,
    listWorkflowVersions: async () => [],
    insertModel: (input) => mutations({ inTx: false }).insertModel(input),
    updateModelStatus: (modelId, status) => mutations({ inTx: false }).updateModelStatus(modelId, status),
    insertModelVersion: (input) => mutations({ inTx: false }).insertModelVersion(input),
    insertWorkflow: async () => {
      throw new Error("not used");
    },
    updateWorkflowStatus: async () => {
      throw new Error("not used");
    },
    insertWorkflowVersion: async () => {
      throw new Error("not used");
    },
    /**
     * D2.4-1 transaction semantics: the fake buffers the mutation result and
     * commits it to `state` only on success — an audit failure (thrown inside
     * `work`) aborts the "commit" exactly like a real rollback.
     */
    runInTransaction: async (work) => {
      const pendingModels = new Map(state.models);
      const pendingVersions = [...state.modelVersions];
      const pendingAudit = [...auditLog];
      try {
        const value = await work(mutations({ inTx: true }));
        return value; // success: state already holds the mutation
      } catch (e) {
        // rollback: drop everything the aborted transaction wrote
        state.models = pendingModels;
        state.modelVersions = pendingVersions;
        auditLog.length = 0;
        auditLog.push(...pendingAudit);
        throw e;
      }
    },
    auditLog,
    auditShouldFail,
    state,
  };
  return repo;
};

describe("catalog service: registerModel", () => {
  it("registers a model with same-transaction audit record", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const res = await svc.registerModel(actor(), { name: "img-core", capabilityKind: "image.generation", displayName: "Img Core", vendorLabel: "Acme" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe("active");
      expect(res.value.capabilityKind).toBe("image.generation");
    }
    expect(repo.auditLog).toHaveLength(1);
    expect(repo.auditLog[0]!.action).toBe("catalog.model.register");
  });

  it("rejects a missing model.manage capability", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const res = await svc.registerModel(actor({ capabilities: [] }), { name: "x", capabilityKind: "image.generation", displayName: "x", vendorLabel: "v" });
    expect(res).toMatchObject({ ok: false, error: { reason: "missing_capability" } });
    expect(repo.auditLog).toHaveLength(0);
  });

  it("rejects an unknown capability kind", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const res = await svc.registerModel(actor(), { name: "x", capabilityKind: "time.travel", displayName: "x", vendorLabel: "v" });
    expect(res).toMatchObject({ ok: false, error: { reason: "invalid_request" } });
  });

  it("rejects a duplicate (org, name)", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    await svc.registerModel(actor(), { name: "dup", capabilityKind: "audio", displayName: "d", vendorLabel: "v" });
    const res = await svc.registerModel(actor(), { name: "dup", capabilityKind: "audio", displayName: "d", vendorLabel: "v" });
    expect(res).toMatchObject({ ok: false, error: { reason: "duplicate_name" } });
  });

  it("audit failure rolls back the mutation (D2.4-1)", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    repo.auditShouldFail.value = true;
    // The audit failure propagates out of the transaction (the Drizzle
    // transaction path rolls back the mutation; the in-memory fake aborts
    // the same way) — the mutation cannot commit without its audit record.
    await expect(
      svc.registerModel(actor(), { name: "rolled-back", capabilityKind: "audio", displayName: "d", vendorLabel: "v" }),
    ).rejects.toThrow("audit write failed");
    expect(repo.state.models.size).toBe(0);
    expect(repo.auditLog).toHaveLength(0);
  });
});

describe("catalog service: registerModelVersion", () => {
  it("registers a version on an active model with same-transaction audit", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const created = await svc.registerModel(actor(), { name: "m", capabilityKind: "image.generation", displayName: "m", vendorLabel: "v" });
    if (!created.ok) throw new Error("setup failed");
    const res = await svc.registerModelVersion(actor(), { modelId: created.value.id, version: "1.0.0", adapterRef: "acme-img-1", compatibility: { maxResolution: "4096x4096" } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe("active");
      expect(res.value.adapterRef).toBe("acme-img-1");
    }
    expect(repo.auditLog.map((a) => a.action)).toEqual(["catalog.model.register", "catalog.model_version.register"]);
  });

  it("inherits deprecated status when the parent model is deprecated", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const created = await svc.registerModel(actor(), { name: "m", capabilityKind: "image.generation", displayName: "m", vendorLabel: "v" });
    if (!created.ok) throw new Error("setup failed");
    await svc.updateModelStatus(actor(), { modelId: created.value.id, status: "deprecated" });
    const res = await svc.registerModelVersion(actor(), { modelId: created.value.id, version: "2.0.0", adapterRef: "a" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("deprecated");
  });

  it("rejects a duplicate (org, model, version)", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const created = await svc.registerModel(actor(), { name: "m", capabilityKind: "image.generation", displayName: "m", vendorLabel: "v" });
    if (!created.ok) throw new Error("setup failed");
    await svc.registerModelVersion(actor(), { modelId: created.value.id, version: "1.0.0", adapterRef: "a" });
    const res = await svc.registerModelVersion(actor(), { modelId: created.value.id, version: "1.0.0", adapterRef: "a" });
    expect(res).toMatchObject({ ok: false, error: { reason: "duplicate_version" } });
  });

  it("cross-org model targets are indistinguishable from missing (IDOR-safe)", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const created = await svc.registerModel(actor(), { name: "m", capabilityKind: "image.generation", displayName: "m", vendorLabel: "v" });
    if (!created.ok) throw new Error("setup failed");
    const res = await svc.registerModelVersion(actor({ organizationId: "99999999-9999-4999-8999-999999999999" }), { modelId: created.value.id, version: "1.0.0", adapterRef: "a" });
    expect(res).toMatchObject({ ok: false, error: { reason: "model_not_found" } });
  });

  it("rejects an empty adapterRef", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const created = await svc.registerModel(actor(), { name: "m", capabilityKind: "image.generation", displayName: "m", vendorLabel: "v" });
    if (!created.ok) throw new Error("setup failed");
    const res = await svc.registerModelVersion(actor(), { modelId: created.value.id, version: "1.0.0", adapterRef: "  " });
    expect(res).toMatchObject({ ok: false, error: { reason: "invalid_request" } });
  });
});

describe("catalog service: updateModelStatus", () => {
  it("follows the approved transition map (active -> deprecated -> active -> disabled)", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const created = await svc.registerModel(actor(), { name: "m", capabilityKind: "image.generation", displayName: "m", vendorLabel: "v" });
    if (!created.ok) throw new Error("setup failed");
    const toDeprecated = await svc.updateModelStatus(actor(), { modelId: created.value.id, status: "deprecated" });
    expect(toDeprecated).toMatchObject({ ok: true });
    const backToActive = await svc.updateModelStatus(actor(), { modelId: created.value.id, status: "active" });
    expect(backToActive).toMatchObject({ ok: true });
    const toDisabled = await svc.updateModelStatus(actor(), { modelId: created.value.id, status: "disabled" });
    expect(toDisabled).toMatchObject({ ok: true, value: { status: "disabled" } });
  });

  it("rejects disabled -> deprecated (not in the transition map)", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const created = await svc.registerModel(actor(), { name: "m", capabilityKind: "image.generation", displayName: "m", vendorLabel: "v" });
    if (!created.ok) throw new Error("setup failed");
    await svc.updateModelStatus(actor(), { modelId: created.value.id, status: "disabled" });
    const res = await svc.updateModelStatus(actor(), { modelId: created.value.id, status: "deprecated" });
    expect(res).toMatchObject({ ok: false, error: { reason: "invalid_transition" } });
  });

  it("records the transition in the same-transaction audit record", async () => {
    const repo = makeRepo();
    const svc = createCatalogService({ repository: repo });
    const created = await svc.registerModel(actor(), { name: "m", capabilityKind: "image.generation", displayName: "m", vendorLabel: "v" });
    if (!created.ok) throw new Error("setup failed");
    await svc.updateModelStatus(actor(), { modelId: created.value.id, status: "deprecated" });
    expect(repo.auditLog.at(-1)).toMatchObject({ action: "catalog.model.status_update" });
  });
});

describe("catalog service: D2.4-1 posture", () => {
  it("fail-closed when the repository lacks runInTransaction (no test-only flag)", async () => {
    const repo = makeRepo();
    const noTx: CatalogRepository = { ...repo, runInTransaction: undefined } as unknown as CatalogRepository;
    const svc = createCatalogService({ repository: noTx });
    await expect(
      svc.registerModel(actor(), { name: "x", capabilityKind: "audio", displayName: "x", vendorLabel: "v" }),
    ).rejects.toThrow(/D2\.4-1 violation/);
  });

  it("uses the sequential fallback ONLY when the test-only flag is set", async () => {
    const repo = makeRepo();
    const noTx: CatalogRepository = { ...repo, runInTransaction: undefined } as unknown as CatalogRepository;
    const auditAppend = vi.fn(async () => {});
    const svc = createCatalogService({ repository: noTx, auditAppend, allowSequentialAudit: true });
    const res = await svc.registerModel(actor(), { name: "x", capabilityKind: "audio", displayName: "x", vendorLabel: "v" });
    expect(res.ok).toBe(true);
    expect(auditAppend).toHaveBeenCalledTimes(1);
  });
});
