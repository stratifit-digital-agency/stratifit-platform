import { describe, expect, it } from "vitest";
import type { ProductionManifest } from "@stratifit/contracts";
import { evaluateProductionGate } from "./gate";
import { buildManifest } from "./manifest-builder";

const manifest = (): ProductionManifest =>
  buildManifest({
    organizationId: "org-1",
    productionId: "prod-1",
    approvedBy: "operator@example.com",
    sceneCount: 2,
    shotCount: 5,
    modelSelections: [{ capability: "image.generation", modelId: "m-1", modelVersion: "1.0.0" }],
    workflowSelections: [{ workflowId: "wf-1", workflowVersion: "1.0.0" }],
    computeEstimate: {
      gpuClass: "rtx-4090",
      vramGb: 24,
      workers: 1,
      concurrency: 1,
      estimatedRuntimeSeconds: 120,
      storageMb: 512,
      estimatedCostUsd: 0.5,
    },
    rights: { digitalHumanRightsConfirmed: true, voiceRightsConfirmed: true },
    safety: { moderationRequired: false },
    plan: { scenes: [] },
  });

describe("evaluateProductionGate", () => {
  it("passes a complete, rights-confirmed manifest", () => {
    const decision = evaluateProductionGate({ manifest: manifest() });
    expect(decision.passed).toBe(true);
  });

  it("fails when rights are unconfirmed", () => {
    const m = manifest();
    const decision = evaluateProductionGate({
      manifest: { ...m, rights: { digitalHumanRightsConfirmed: false, voiceRightsConfirmed: true } },
    });
    expect(decision.passed).toBe(false);
    if (!decision.passed) expect(decision.issues.map((i) => i.code)).toContain("rights_not_confirmed");
  });

  it("fails when over budget", () => {
    const decision = evaluateProductionGate({ manifest: manifest(), budgetUsd: 0.1 });
    expect(decision.passed).toBe(false);
    if (!decision.passed) expect(decision.issues.map((i) => i.code)).toContain("over_budget");
  });

  it("fails when no shots are planned", () => {
    const m = manifest();
    const decision = evaluateProductionGate({ manifest: { ...m, shotCount: 0 } });
    expect(decision.passed).toBe(false);
    if (!decision.passed) expect(decision.issues.map((i) => i.code)).toContain("missing_shots");
  });

  it("fails when moderation is required but unplanned", () => {
    const m = manifest();
    const decision = evaluateProductionGate({
      manifest: { ...m, safety: { moderationRequired: true } },
    });
    expect(decision.passed).toBe(false);
    if (!decision.passed)
      expect(decision.issues.map((i) => i.code)).toContain("moderation_not_planned");
  });

  it("passes with moderation acknowledged", () => {
    const m = manifest();
    const decision = evaluateProductionGate({
      manifest: { ...m, safety: { moderationRequired: true } },
      moderationPlanned: true,
    });
    expect(decision.passed).toBe(true);
  });
});
