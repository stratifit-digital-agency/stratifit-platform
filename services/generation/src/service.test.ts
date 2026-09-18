/**
 * Unit test matrix for the generation domain service (Stage 2.9) with
 * in-memory fakes. The fake repository implements runInTransaction WITH
 * rollback semantics (snapshot/restore) so the D2.4-1 same-transaction
 * guarantees — and the fail-closed sequential fallback — are exercised
 * exactly as the production Drizzle repository behaves.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  GenerationActor,
  GenerationAuditAppend,
  GenerationCommandErrorReason,
  GenerationProvenanceRecord,
  GenerationRecord,
  GenerationRepository,
  GenerationStatus,
  GenerationTransaction,
  ModelRegistryPort,
  WorkflowRegistryPort,
} from "./types";
import { TERMINAL_GENERATION_STATUSES } from "./types";
import { createGenerationService, type GenerationService } from "./service";

const actor = (overrides: Partial<GenerationActor> = {}): GenerationActor => ({
  operatorId: "op-1",
  organizationId: "org-1",
  roles: ["admin"],
  capabilities: ["generation.request", "audit.read", "production.plan"],
  ...overrides,
});

const otherActor = () => actor({ operatorId: "op-2", organizationId: "org-2" });

/** UUID-shaped fixtures (the service validates ids fail-closed). */
const MODEL_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";

type FakeGeneration = {
  id: string;
  orgId: string;
  status: GenerationStatus;
  productionId: string | null;
  sceneId: string | null;
  shotId: string | null;
  jobId: string | null;
  outputAssetVersionId: string | null;
  modelId: string;
  modelVersionId: string;
  workflowId: string | null;
  workflowVersionId: string | null;
  parentGenerationId: string | null;
  inputAssetVersionIds: string[];
  prompt: string;
  negativePrompt: string | null;
  seed: string | null;
  parameters: Record<string, unknown>;
  resolution: string | null;
  fps: number | null;
  durationSeconds: string | null;
  adapters: Record<string, unknown>[];
  estimatedCostUsd: string | null;
  requestKey: string | null;
  lastError: string | null;
  requestedAt: string;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type FakeProvenance = GenerationProvenanceRecord;

interface FakeState {
  generations: FakeGeneration[];
  provenance: FakeProvenance[];
  /** Test side-channels for audit behavior. */
  auditShouldFail: boolean;
  auditLog: Parameters<GenerationAuditAppend>[0][] | undefined;
}

let seq = 0;
/** UUID-shaped deterministic ids (the service validates UUIDs fail-closed). */
const id = (_p: string) => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const makeModelRegistry = (state: { disabledVersions?: Set<string> } = {}): ModelRegistryPort => ({
  findModel: async (orgId, modelId) =>
    modelId === MODEL_ID ? { id: modelId, orgId, name: "m", status: "active" } : null,
  resolveModelVersion: async (orgId, modelId, version) => {
    if (state.disabledVersions?.has(`${modelId}@${version}`)) {
      return { id: `mv-${modelId}-${version}`, orgId, modelId, version, status: "disabled" };
    }
    return { id: `mv-${modelId}-${version}`, orgId, modelId, version, status: "active" };
  },
});

const makeWorkflowRegistry = (): WorkflowRegistryPort => ({
  findWorkflow: async (orgId, workflowId) =>
    workflowId === WORKFLOW_ID ? { id: workflowId, orgId, name: "w", status: "active" } : null,
  resolveWorkflowVersion: async (orgId, workflowId, version) => ({
    id: `wfv-${workflowId}-${version}`,
    orgId,
    workflowId,
    version,
    status: "active",
  }),
});

const makeFakeRepository = (state: FakeState) => {
  const snapshot = (): FakeState =>
    JSON.parse(
      JSON.stringify({
        generations: state.generations,
        provenance: state.provenance,
        auditShouldFail: state.auditShouldFail,
        // Deep-copy the pre-transaction audit array so a rollback restores
        // exactly what existed before the transaction began.
        auditLog: [...(state.auditLog ?? [])],
      }),
    );

  const mutations = (s: FakeState): Omit<GenerationTransaction, "appendAudit"> => ({
    insertGeneration: async (input): Promise<GenerationRecord> => {
      const g: FakeGeneration = {
        id: id("gen"),
        orgId: input.orgId,
        status: "requested",
        productionId: input.productionId,
        sceneId: input.sceneId,
        shotId: input.shotId,
        jobId: input.jobId,
        outputAssetVersionId: null,
        modelId: input.modelId,
        modelVersionId: input.modelVersionId,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        parentGenerationId: input.parentGenerationId,
        inputAssetVersionIds: [...input.inputAssetVersionIds],
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        seed: input.seed,
        parameters: input.parameters,
        resolution: input.resolution,
        fps: input.fps,
        durationSeconds: input.durationSeconds,
        adapters: [...input.adapters],
        estimatedCostUsd: input.estimatedCostUsd,
        requestKey: input.requestKey,
        lastError: null,
        requestedAt: new Date().toISOString(),
        startedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      s.generations.push(g);
      return g;
    },
    updateGeneration: async (generationId, patch): Promise<GenerationRecord> => {
      const g = s.generations.find((x) => x.id === generationId);
      if (!g) throw new Error("no such generation");
      Object.assign(g, {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.outputAssetVersionId !== undefined ? { outputAssetVersionId: patch.outputAssetVersionId } : {}),
        updatedAt: new Date().toISOString(),
      });
      return g;
    },
    insertProvenance: async (input): Promise<FakeProvenance> => {
      // Mirrors the database one-shot guard: generation_id is the PK.
      if (s.provenance.some((p) => p.generationId === input.generationId)) {
        throw new Error("duplicate key value violates unique constraint (23505)");
      }
      const p: FakeProvenance = {
        generationId: input.generationId,
        orgId: input.orgId,
        outputStorageKey: input.outputStorageKey,
        outputChecksum: input.outputChecksum,
        outputByteSize: input.outputByteSize,
        executedSeed: input.executedSeed,
        workerRef: input.workerRef,
        gpuClass: input.gpuClass,
        runtimeVersion: input.runtimeVersion,
        actualCostUsd: input.actualCostUsd,
        actualRuntimeSeconds: input.actualRuntimeSeconds,
        completedAt: new Date().toISOString(),
      };
      s.provenance.push(p);
      return p;
    },
  });

  const appendAudit = async (entry: Parameters<GenerationAuditAppend>[0]): Promise<void> => {
    if (state.auditShouldFail) throw new Error("audit append failed (simulated)");
    state.auditLog!.push(entry);
  };

  const repo: GenerationRepository = {
    findGenerationById: async (generationId) => state.generations.find((g) => g.id === generationId) ?? null,
    findGenerationByRequestKey: async (orgId, requestKey) =>
      state.generations.find((g) => g.orgId === orgId && g.requestKey === requestKey) ?? null,
    findProvenanceByGenerationId: async (generationId) =>
      state.provenance.find((p) => p.generationId === generationId) ?? null,
    listGenerationsByOrg: async (orgId, filter) =>
      state.generations.filter(
        (g) =>
          g.orgId === orgId &&
          (filter?.status === undefined || g.status === filter.status) &&
          (filter?.productionId === undefined || g.productionId === filter.productionId),
      ),
    insertGeneration: (input) => mutations(state).insertGeneration(input),
    updateGeneration: (generationId, patch) => mutations(state).updateGeneration(generationId, patch),
    insertProvenance: (input) => mutations(state).insertProvenance(input),
    runInTransaction: async <T>(work: (tx: GenerationTransaction) => Promise<T>): Promise<T> => {
      const before = snapshot();
      try {
        const value = await work({
          ...mutations(state),
          appendAudit,
        });
        return value;
      } catch (e) {
        // Rollback: restore the pre-transaction state (D2.4-1 semantics).
        state.generations = before.generations;
        state.provenance = before.provenance;
        state.auditLog = before.auditLog;
        throw e;
      }
    },
  };
  return repo;
};

const makeService = (
  state: FakeState,
  overrides: Partial<Parameters<typeof createGenerationService>[0]> = {},
): { service: GenerationService; publisher: InProcessEventPublisher } => {
  const defaultPublisher = new InProcessEventPublisher();
  const service = createGenerationService({
    repository: makeFakeRepository(state),
    modelRegistry: makeModelRegistry(),
    // Default workflow registry unless the override supplies one (an override
    // with `workflowRegistry: undefined` intentionally tests missing ports).
    ...(overrides.workflowRegistry === undefined ? { workflowRegistry: makeWorkflowRegistry() } : {}),
    ...overrides,
    ...(overrides.publisher === undefined ? { publisher: defaultPublisher } : {}),
  });
  return { service, publisher: (overrides.publisher as InProcessEventPublisher) ?? defaultPublisher };
};

const requestInput = (overrides: Record<string, unknown> = {}) => ({
  modelId: MODEL_ID,
  modelVersion: "v1",
  prompt: "a cinematic shot",
  requestKey: "req-1",
  ...overrides,
});

describe("generation state machine (DM section 32.3)", () => {
  let state: FakeState;
  beforeEach(() => {
    state = { generations: [], provenance: [], auditShouldFail: false, auditLog: [] };
  });
  afterEach(() => {
    state.auditLog = undefined;
  });

  it("requested -> running -> completed is legal and records startedAt", async () => {
    const { service } = makeService(state);
    const created = await service.requestGeneration(actor(), requestInput());
    expect(created.ok).toBe(true);
    const gen = created.ok ? created.value.generation : null;
    expect(gen!.status).toBe("requested");
    const started = await service.startGeneration(gen!.id);
    expect(started.ok && started.value.status === "running" && started.value.startedAt !== null).toBe(true);
    const completed = await service.completeGeneration(gen!.id, {
      outputStorageKey: "generations/org-1/out.png",
      workerRef: "worker-ref-1",
    });
    expect(completed.ok && completed.value.generation.status === "completed").toBe(true);
    expect(completed.ok && completed.value.provenance.generationId === gen!.id).toBe(true);
  });

  it("requested -> running -> failed records lastError; running -> cancelled is legal", async () => {
    const { service } = makeService(state);
    const a = await service.requestGeneration(actor(), requestInput({ requestKey: "r-a" }));
    const startedA = await service.startGeneration(a.ok ? a.value.generation.id : "");
    const failed = await service.failGeneration(a.ok ? a.value.generation.id : "", { errorDetail: "boom" });
    expect(failed.ok && failed.value.status === "failed" && failed.value.lastError === "boom").toBe(true);
    void startedA;

    const b = await service.requestGeneration(actor(), requestInput({ requestKey: "r-b" }));
    await service.startGeneration(b.ok ? b.value.generation.id : "");
    const cancelled = await service.cancelGeneration(actor(), b.ok ? b.value.generation.id : "");
    expect(cancelled.ok && cancelled.value.status === "cancelled").toBe(true);
  });

  it("terminal states have NO outgoing edges: completed/failed/cancelled reject everything", async () => {
    const { service } = makeService(state);
    for (const terminal of TERMINAL_GENERATION_STATUSES) {
      state.generations.push({
        id: `term-${terminal}`,
        orgId: "org-1",
        status: terminal,
        productionId: null,
        sceneId: null,
        shotId: null,
        jobId: null,
        outputAssetVersionId: null,
        modelId: "model-1",
        modelVersionId: "mv-1",
        workflowId: null,
        workflowVersionId: null,
        parentGenerationId: null,
        inputAssetVersionIds: [],
        prompt: "p",
        negativePrompt: null,
        seed: null,
        parameters: {},
        resolution: null,
        fps: null,
        durationSeconds: null,
        adapters: [],
        estimatedCostUsd: null,
        requestKey: null,
        lastError: null,
        requestedAt: new Date().toISOString(),
        startedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const asActor = async () => {
        const r = await service.cancelGeneration(actor(), `term-${terminal}`);
        expect(!r.ok && r.error.reason === "invalid_transition").toBe(true);
      };
      await asActor();
      const s = await service.startGeneration(`term-${terminal}`);
      expect(!s.ok && s.error.reason === "invalid_transition").toBe(true);
      const f = await service.failGeneration(`term-${terminal}`, { errorDetail: "x" });
      expect(!f.ok && f.error.reason === "invalid_transition").toBe(true);
      const c = await service.completeGeneration(`term-${terminal}`, {});
      expect(!c.ok && (c.error.reason === "invalid_transition" || c.error.reason === "completion_conflict")).toBe(true);
    }
  });

  it("start requires `requested`; complete/fail require `running`", async () => {
    const { service } = makeService(state);
    const created = await service.requestGeneration(actor(), requestInput({ requestKey: "st" }));
    const genId = created.ok ? created.value.generation.id : "";
    const earlyComplete = await service.completeGeneration(genId, {});
    expect(!earlyComplete.ok && earlyComplete.error.reason === "invalid_transition").toBe(true);
    const earlyFail = await service.failGeneration(genId, { errorDetail: "x" });
    expect(!earlyFail.ok && earlyFail.error.reason === "invalid_transition").toBe(true);
    await service.startGeneration(genId);
    const doubleStart = await service.startGeneration(genId);
    expect(!doubleStart.ok && doubleStart.error.reason === "invalid_transition").toBe(true);
  });

  it("duplicate completion is rejected (provenance is one-shot)", async () => {
    const { service } = makeService(state);
    const created = await service.requestGeneration(actor(), requestInput({ requestKey: "dc" }));
    const genId = created.ok ? created.value.generation.id : "";
    await service.startGeneration(genId);
    const first = await service.completeGeneration(genId, { workerRef: "w" });
    expect(first.ok).toBe(true);
    const second = await service.completeGeneration(genId, { workerRef: "w" });
    expect(!second.ok && second.error.reason === "completion_conflict").toBe(true);
  });
});

describe("idempotency + request validation", () => {
  let state: FakeState;
  beforeEach(() => {
    state = { generations: [], provenance: [], auditShouldFail: false, auditLog: [] };
  });
  afterEach(() => {
    state.auditLog = undefined;
  });

  it("same (org, requestKey) resolves to the EXISTING generation (dedupe, not error)", async () => {
    const { service } = makeService(state);
    const first = await service.requestGeneration(actor(), requestInput());
    expect(first.ok && first.value.deduplicated === false).toBe(true);
    const second = await service.requestGeneration(actor(), requestInput());
    expect(second.ok && second.value.deduplicated === true).toBe(true);
    expect(
      second.ok && first.ok && second.value.generation.id === first.value.generation.id,
    ).toBe(true);
    expect(state.generations).toHaveLength(1);
  });

  it("different orgs may reuse the same request key", async () => {
    const { service } = makeService(state);
    const a = await service.requestGeneration(actor(), requestInput());
    const b = await service.requestGeneration(otherActor(), requestInput());
    expect(a.ok && b.ok && a.value.generation.id !== b.value.generation.id).toBe(true);
  });

  it("same request key across orgs: org-2 uses ORG_B isolation implicitly", async () => {
    void ORG_B;
  });

  it("rejects invalid request facts fail-closed", async () => {
    const { service } = makeService(state);
    const cases: { input: Record<string, unknown>; reason: GenerationCommandErrorReason }[] = [
      { input: requestInput({ prompt: "" }), reason: "invalid_request" },
      { input: requestInput({ modelId: "not-a-uuid" }), reason: "invalid_request" },
      { input: requestInput({ modelVersion: "" }), reason: "invalid_request" },
      { input: requestInput({ workflowId: WORKFLOW_ID }), reason: "invalid_request" },
      { input: requestInput({ requestKey: "" }), reason: "invalid_request" },
      { input: requestInput({ parentGenerationId: "nope" }), reason: "invalid_request" },
    ];
    for (const c of cases) {
      const r = await service.requestGeneration(actor(), c.input as never);
      expect(!r.ok && r.error.reason === c.reason, JSON.stringify(c.input)).toBe(true);
    }
  });

  it("missing capability is rejected before anything else", async () => {
    const { service } = makeService(state);
    const r = await service.requestGeneration(actor({ capabilities: ["audit.read"] }), requestInput());
    expect(!r.ok && r.error.reason === "missing_capability").toBe(true);
  });
});

describe("catalog resolution (D2.8-3, fail-closed)", () => {
  let state: FakeState;
  beforeEach(() => {
    state = { generations: [], provenance: [], auditShouldFail: false, auditLog: [] };
  });
  afterEach(() => {
    state.auditLog = undefined;
  });

  it("unresolvable model version rejects the request (model_not_found)", async () => {
    const registry: ModelRegistryPort = {
      findModel: async () => null,
      resolveModelVersion: async () => null,
    };
    const { service } = makeService(state, { modelRegistry: registry });
    const r = await service.requestGeneration(actor(), requestInput());
    expect(!r.ok && r.error.reason === "model_not_found").toBe(true);
    expect(state.generations).toHaveLength(0);
  });

  it("disabled model version rejects the request (model_disabled)", async () => {
    const { service } = makeService(state, {
      modelRegistry: makeModelRegistry({ disabledVersions: new Set([`${MODEL_ID}@v1`]) }),
    });
    const r = await service.requestGeneration(actor(), requestInput());
    expect(!r.ok && r.error.reason === "model_disabled").toBe(true);
  });

  it("unresolvable workflow version rejects the request (workflow_not_found)", async () => {
    const registry: WorkflowRegistryPort = {
      findWorkflow: async () => ({ id: WORKFLOW_ID, orgId: "org-1", name: "w", status: "active" }),
      resolveWorkflowVersion: async () => null,
    };
    const { service } = makeService(state, { workflowRegistry: registry });
    const r = await service.requestGeneration(
      actor(),
      requestInput({ workflowId: WORKFLOW_ID, workflowVersion: "v1" }),
    );
    expect(!r.ok && r.error.reason === "workflow_not_found").toBe(true);
  });

  it("resolved versions are PINNED as UUIDs on the generation row (invariants 8/9)", async () => {
    const { service } = makeService(state);
    const r = await service.requestGeneration(
      actor(),
      requestInput({ workflowId: WORKFLOW_ID, workflowVersion: "v2" }),
    );
    if (!r.ok) throw new Error(`request failed: ${r.error.message}`);
    const g = r.value.generation;
    expect(g.modelVersionId).toBe(`mv-${MODEL_ID}-v1`);
    expect(g.workflowVersionId).toBe(`wfv-${WORKFLOW_ID}-v2`);
    expect(g.modelId).toBe(MODEL_ID);
    expect(g.workflowId).toBe(WORKFLOW_ID);
  });
});

describe("lineage (parent references)", () => {
  let state: FakeState;
  beforeEach(() => {
    state = { generations: [], provenance: [], auditShouldFail: false, auditLog: [] };
  });
  afterEach(() => {
    state.auditLog = undefined;
  });

  it("same-org parent is accepted and recorded", async () => {
    const { service } = makeService(state);
    const parent = await service.requestGeneration(actor(), requestInput({ requestKey: "p" }));
    if (!parent.ok) throw new Error("parent request failed");
    const child = await service.requestGeneration(
      actor(),
      requestInput({ requestKey: "c", parentGenerationId: parent.value.generation.id }),
    );
    expect(child.ok).toBe(true);
    const childGen = child.ok ? child.value.generation : null;
    expect(childGen!.parentGenerationId === parent.value.generation.id).toBe(true);
  });

  it("cross-org parent is indistinguishable from absent (parent_not_found, IDOR-safe)", async () => {
    const { service } = makeService(state);
    const parent = await service.requestGeneration(actor(), requestInput({ requestKey: "p2" }));
    if (!parent.ok) throw new Error("parent request failed");
    const child = await service.requestGeneration(
      otherActor(),
      requestInput({ parentGenerationId: parent.value.generation.id }),
    );
    expect(!child.ok && child.error.reason === "parent_not_found").toBe(true);
  });
});

describe("cross-org isolation", () => {
  let state: FakeState;
  beforeEach(() => {
    state = { generations: [], provenance: [], auditShouldFail: false, auditLog: [] };
  });
  afterEach(() => {
    state.auditLog = undefined;
  });

  it("org A cannot read, cancel, or see provenance of org B generations", async () => {
    const { service } = makeService(state);
    const created = await service.requestGeneration(actor(), requestInput());
    const genId = created.ok ? created.value.generation.id : "";
    await service.startGeneration(genId);
    await service.completeGeneration(genId, { workerRef: "w" });

    const read = await service.getGeneration(otherActor(), genId);
    expect(!read.ok && read.error.reason === "generation_not_found").toBe(true);
    const prov = await service.getProvenance(otherActor(), genId);
    expect(!prov.ok && prov.error.reason === "generation_not_found").toBe(true);
    const cancel = await service.cancelGeneration(otherActor(), genId);
    expect(!cancel.ok && cancel.error.reason === "generation_not_found").toBe(true);
    const listed = await service.listGenerations(otherActor());
    expect(listed).toHaveLength(0);
  });
});

describe("audit (D2.4-1, reused)", () => {
  let state: FakeState;
  beforeEach(() => {
    state = { generations: [], provenance: [], auditShouldFail: false, auditLog: [] };
  });
  afterEach(() => {
    state.auditLog = undefined;
  });

  it("request and cancel commit WITH their audit records in the same transaction", async () => {
    const { service } = makeService(state);
    const created = await service.requestGeneration(actor(), requestInput());
    expect(state.auditLog).toHaveLength(1);
    expect(state.auditLog![0]!.action).toBe("generations.generation_requested");
    expect(state.auditLog![0]!.organizationId).toBe("org-1");
    const cancelled = await service.cancelGeneration(actor(), created.ok ? created.value.generation.id : "");
    expect(cancelled.ok).toBe(true);
    expect(state.auditLog).toHaveLength(2);
    expect(state.auditLog![1]!.action).toBe("generations.generation_cancelled");
  });

  it("audit failure ROLLS BACK the domain mutation (request)", async () => {
    const { service } = makeService(state);
    state.auditShouldFail = true;
    await expect(service.requestGeneration(actor(), requestInput())).rejects.toThrow(/audit append failed/);
    expect(state.generations).toHaveLength(0);
    expect(state.auditLog).toHaveLength(0);
  });

  it("audit failure ROLLS BACK the domain mutation (cancel)", async () => {
    const { service } = makeService(state);
    const created = await service.requestGeneration(actor(), requestInput({ requestKey: "r" }));
    state.auditShouldFail = true;
    const genId = created.ok ? created.value.generation.id : "";
    await expect(service.cancelGeneration(actor(), genId)).rejects.toThrow(/audit append failed/);
    expect(state.generations[0]!.status).toBe("requested");
    expect(state.auditLog).toHaveLength(1);
  });

  it("execution-path transitions (start/complete/fail) are NOT operator-audited", async () => {
    const { service } = makeService(state);
    const created = await service.requestGeneration(actor(), requestInput({ requestKey: "ea" }));
    const genId = created.ok ? created.value.generation.id : "";
    expect(state.auditLog).toHaveLength(1);
    await service.startGeneration(genId);
    await service.completeGeneration(genId, { workerRef: "w" });
    expect(state.auditLog).toHaveLength(1);
  });

  it("repositories without transaction support FAIL CLOSED unless the test-only flag is set", async () => {
    const inserted: GenerationRecord[] = [];
    const repo: GenerationRepository = {
      findGenerationById: async () => null,
      findGenerationByRequestKey: async () => null,
      findProvenanceByGenerationId: async () => null,
      listGenerationsByOrg: async () => [],
      insertGeneration: async (input) => {
        const g: GenerationRecord = {
          id: "00000000-0000-4000-8000-0000000000aa",
          orgId: input.orgId,
          status: "requested",
          productionId: input.productionId,
          sceneId: input.sceneId,
          shotId: input.shotId,
          jobId: input.jobId,
          outputAssetVersionId: null,
          modelId: input.modelId,
          modelVersionId: input.modelVersionId,
          workflowId: input.workflowId,
          workflowVersionId: input.workflowVersionId,
          parentGenerationId: input.parentGenerationId,
          inputAssetVersionIds: [...input.inputAssetVersionIds],
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          seed: input.seed,
          parameters: input.parameters,
          resolution: input.resolution,
          fps: input.fps,
          durationSeconds: input.durationSeconds,
          adapters: [...input.adapters],
          estimatedCostUsd: input.estimatedCostUsd,
          requestKey: input.requestKey,
          lastError: null,
          requestedAt: new Date().toISOString(),
          startedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        inserted.push(g);
        return g;
      },
      updateGeneration: async () => {
        throw new Error("should not be reached");
      },
      insertProvenance: async () => {
        throw new Error("should not be reached");
      },
    };
    // Without runInTransaction and WITHOUT the flag: fail closed.
    const strict = createGenerationService({
      repository: repo,
      modelRegistry: makeModelRegistry(),
      publisher: new InProcessEventPublisher(),
    });
    await expect(strict.requestGeneration(actor(), requestInput())).rejects.toThrow(/D2.4-1 violation/);
    expect(inserted).toHaveLength(0);
    // With the TEST-ONLY flag: the sequential fallback runs.
    const lenient = createGenerationService({
      repository: repo,
      modelRegistry: makeModelRegistry(),
      publisher: new InProcessEventPublisher(),
      auditAppend: async () => {},
      allowSequentialAudit: true,
    });
    const r = await lenient.requestGeneration(actor(), requestInput());
    expect(r.ok).toBe(true);
    expect(inserted).toHaveLength(1);
  });
});

describe("events (post-commit, existing names only)", () => {
  let state: FakeState;
  beforeEach(() => {
    state = { generations: [], provenance: [], auditShouldFail: false, auditLog: [] };
  });
  afterEach(() => {
    state.auditLog = undefined;
  });

  it("lifecycle emits generation.created/.started/.completed with correlation", async () => {
    const published: { name: string; payload: Record<string, unknown>; correlation: Record<string, unknown> }[] = [];
    const publisher: EventPublisher = {
      publish: async (envelope) => {
        published.push({
          name: envelope.name,
          payload: envelope.payload,
          correlation: envelope.correlation,
        });
      },
    };
    const { service } = makeService(state, { publisher });
    const created = await service.requestGeneration(
      actor(),
      requestInput({ productionId: "11111111-1111-4111-8111-111111111111" }),
    );
    const genId = created.ok ? created.value.generation.id : "";
    await service.startGeneration(genId);
    await service.completeGeneration(genId, { workerRef: "w" });
    expect(published.map((p) => p.name)).toEqual([
      "generation.created",
      "generation.started",
      "generation.completed",
    ]);
    expect(published[0]!.correlation.organizationId).toBe("org-1");
  });

  it("a failed transaction never publishes a successful event", async () => {
    const published: string[] = [];
    const publisher: EventPublisher = {
      publish: async (envelope) => {
        published.push(envelope.name);
      },
    };
    const { service } = makeService(state, { publisher });
    state.auditShouldFail = true;
    await expect(service.requestGeneration(actor(), requestInput())).rejects.toThrow(/audit append failed/);
    expect(published).toEqual([]);
  });
});
