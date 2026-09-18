/**
 * Unit tests for the workflow catalog service (Stage 2.8).
 *
 * Mirrors the model-side matrix: capability gating (`workflow.manage`),
 * org-boundary IDOR safety, duplicate name/version conflicts, status
 * transition guard, inherited version status, and D2.4-1 same-transaction
 * audit semantics (audit failure aborts the commit; sequential fallback
 * fail-closed without the test-only flag).
 */
import { describe, expect, it, vi } from "vitest";
import type {
  WorkflowCatalogActor,
  WorkflowCatalogRecord,
  WorkflowCatalogRepository,
  WorkflowCatalogTransaction,
  WorkflowRegistryStatus,
  WorkflowVersionRecord,
} from "./types";
import { createWorkflowCatalogService } from "./service";

const actor = (over: Partial<WorkflowCatalogActor> = {}): WorkflowCatalogActor => ({
  operatorId: "op-1",
  organizationId: "11111111-1111-4111-8111-111111111111",
  roles: ["operator"],
  capabilities: ["workflow.manage", "admin.permissions"],
  ...over,
});

const workflow = (over: Partial<WorkflowCatalogRecord> = {}): WorkflowCatalogRecord => ({
  id: "22222222-2222-4222-8222-222222222222",
  orgId: "11111111-1111-4111-8111-111111111111",
  name: "img-core-flow",
  supports: ["image.generation"],
  status: "active",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...over,
});

const makeRepo = () => {
  const auditLog: { action: string; targetId: string }[] = [];
  const auditShouldFail = { value: false };
  const state = {
    workflows: new Map<string, WorkflowCatalogRecord>(),
    workflowVersions: [] as WorkflowVersionRecord[],
  };
  const mutations = (): WorkflowCatalogTransaction => ({
    insertWorkflow: async (input) => {
      const row = workflow({ ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      state.workflows.set(row.id, row);
      return row;
    },
    updateWorkflowStatus: async (workflowId, status) => {
      const row = state.workflows.get(workflowId);
      if (!row) throw new Error("no row");
      const updated = { ...row, status, updatedAt: new Date().toISOString() };
      state.workflows.set(workflowId, updated);
      return updated;
    },
    insertWorkflowVersion: async (input) => {
      const row: WorkflowVersionRecord = {
        id: crypto.randomUUID(),
        orgId: input.orgId,
        workflowId: input.workflowId,
        version: input.version,
        runtimeRef: input.runtimeRef,
        definition: input.definition,
        compatibility: input.compatibility,
        status: input.status as WorkflowRegistryStatus,
        registeredAt: new Date().toISOString(),
      };
      state.workflowVersions.push(row);
      return row;
    },
    appendAudit: async (entry) => {
      if (auditShouldFail.value) throw new Error("audit write failed");
      auditLog.push({ action: entry.action, targetId: entry.targetId });
    },
  });
  const repo: WorkflowCatalogRepository & {
    auditLog: typeof auditLog;
    auditShouldFail: typeof auditShouldFail;
    state: typeof state;
  } = {
    findWorkflowById: async (id) => state.workflows.get(id) ?? null,
    findWorkflowByName: async (orgId, name) =>
      [...state.workflows.values()].find((w) => w.orgId === orgId && w.name === name) ?? null,
    listWorkflowsByOrg: async (orgId) => [...state.workflows.values()].filter((w) => w.orgId === orgId),
    findWorkflowVersion: async (orgId, workflowId, version) =>
      state.workflowVersions.find((v) => v.orgId === orgId && v.workflowId === workflowId && v.version === version) ?? null,
    listWorkflowVersions: async (workflowId) => state.workflowVersions.filter((v) => v.workflowId === workflowId),
    insertWorkflow: (input) => mutations().insertWorkflow(input),
    updateWorkflowStatus: (workflowId, status) => mutations().updateWorkflowStatus(workflowId, status),
    insertWorkflowVersion: (input) => mutations().insertWorkflowVersion(input),
    runInTransaction: async (work) => {
      const pendingWorkflows = new Map(state.workflows);
      const pendingVersions = [...state.workflowVersions];
      const pendingAudit = [...auditLog];
      try {
        return await work(mutations());
      } catch (e) {
        state.workflows = pendingWorkflows;
        state.workflowVersions = pendingVersions;
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

describe("workflow catalog service: registerWorkflow", () => {
  it("registers a workflow with same-transaction audit", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    const res = await svc.registerWorkflow(actor(), { name: "flow", supports: ["image.generation"] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("active");
    expect(repo.auditLog).toHaveLength(1);
    expect(repo.auditLog[0]!.action).toBe("catalog.workflow.register");
  });

  it("rejects a missing workflow.manage capability", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    const res = await svc.registerWorkflow(actor({ capabilities: [] }), { name: "x", supports: [] });
    expect(res).toMatchObject({ ok: false, error: { reason: "missing_capability" } });
    expect(repo.auditLog).toHaveLength(0);
  });

  it("rejects an unknown capability kind in supports", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    const res = await svc.registerWorkflow(actor(), { name: "x", supports: ["time.travel"] });
    expect(res).toMatchObject({ ok: false, error: { reason: "invalid_request" } });
  });

  it("rejects a duplicate (org, name)", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    await svc.registerWorkflow(actor(), { name: "dup", supports: [] });
    const res = await svc.registerWorkflow(actor(), { name: "dup", supports: [] });
    expect(res).toMatchObject({ ok: false, error: { reason: "duplicate_name" } });
  });

  it("audit failure aborts the commit (D2.4-1)", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    repo.auditShouldFail.value = true;
    await expect(
      svc.registerWorkflow(actor(), { name: "rolled-back", supports: [] }),
    ).rejects.toThrow("audit write failed");
    expect(repo.state.workflows.size).toBe(0);
    expect(repo.auditLog).toHaveLength(0);
  });
});

describe("workflow catalog service: versions and transitions", () => {
  it("registers a version with inherited active status", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    const created = await svc.registerWorkflow(actor(), { name: "flow", supports: ["video.generation"] });
    if (!created.ok) throw new Error("setup failed");
    const res = await svc.registerWorkflowVersion(actor(), {
      workflowId: created.value.id,
      version: "1.0.0",
      runtimeRef: "comfyui",
      definition: { nodes: [] },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe("active");
      expect(res.value.runtimeRef).toBe("comfyui");
    }
    expect(repo.auditLog.map((a) => a.action)).toEqual(["catalog.workflow.register", "catalog.workflow_version.register"]);
  });

  it("rejects a duplicate (org, workflow, version)", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    const created = await svc.registerWorkflow(actor(), { name: "flow", supports: [] });
    if (!created.ok) throw new Error("setup failed");
    await svc.registerWorkflowVersion(actor(), { workflowId: created.value.id, version: "1.0.0", runtimeRef: "r" });
    const res = await svc.registerWorkflowVersion(actor(), { workflowId: created.value.id, version: "1.0.0", runtimeRef: "r" });
    expect(res).toMatchObject({ ok: false, error: { reason: "duplicate_version" } });
  });

  it("cross-org workflow targets are indistinguishable from missing (IDOR-safe)", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    const created = await svc.registerWorkflow(actor(), { name: "flow", supports: [] });
    if (!created.ok) throw new Error("setup failed");
    const res = await svc.registerWorkflowVersion(
      actor({ organizationId: "99999999-9999-4999-8999-999999999999" }),
      { workflowId: created.value.id, version: "1.0.0", runtimeRef: "r" },
    );
    expect(res).toMatchObject({ ok: false, error: { reason: "workflow_not_found" } });
  });

  it("follows the transition map and rejects invalid moves", async () => {
    const repo = makeRepo();
    const svc = createWorkflowCatalogService({ repository: repo });
    const created = await svc.registerWorkflow(actor(), { name: "flow", supports: [] });
    if (!created.ok) throw new Error("setup failed");
    expect(await svc.updateWorkflowStatus(actor(), { workflowId: created.value.id, status: "deprecated" })).toMatchObject({ ok: true });
    expect(await svc.updateWorkflowStatus(actor(), { workflowId: created.value.id, status: "disabled" })).toMatchObject({ ok: true });
    const invalid = await svc.updateWorkflowStatus(actor(), { workflowId: created.value.id, status: "deprecated" });
    expect(invalid).toMatchObject({ ok: false, error: { reason: "invalid_transition" } });
  });

  it("fail-closed without runInTransaction unless the test-only flag is set", async () => {
    const repo = makeRepo();
    const noTx = { ...repo, runInTransaction: undefined } as unknown as WorkflowCatalogRepository;
    const svc = createWorkflowCatalogService({ repository: noTx });
    await expect(svc.registerWorkflow(actor(), { name: "x", supports: [] })).rejects.toThrow(/D2\.4-1 violation/);
    const auditAppend = vi.fn(async () => {});
    const svc2 = createWorkflowCatalogService({ repository: noTx, auditAppend, allowSequentialAudit: true });
    const res = await svc2.registerWorkflow(actor(), { name: "y", supports: [] });
    expect(res.ok).toBe(true);
    expect(auditAppend).toHaveBeenCalledTimes(1);
  });
});
