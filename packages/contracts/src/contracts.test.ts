import { describe, expect, it } from "vitest";
import {
  CapabilityRequest,
  DomainEventEnvelope,
  makeEnvelope,
  MessageRequest,
  ProductionManifest,
  requiresEmailVerification,
} from "./index";

describe("capability contracts", () => {
  it("validates an image generation request", () => {
    const parsed = CapabilityRequest.safeParse({
      kind: "image.generation",
      resolution: { width: 1024, height: 1024 },
      prompt: "a lighthouse at dusk",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown capability kind", () => {
    const parsed = CapabilityRequest.safeParse({ kind: "teleportation", prompt: "x" });
    expect(parsed.success).toBe(false);
  });
});

describe("production manifest", () => {
  const valid = {
    manifestVersion: "1",
    organizationId: "org-1",
    productionId: "prod-1",
    createdAt: new Date().toISOString(),
    approvedBy: "operator@example.com",
    sceneCount: 2,
    shotCount: 5,
    modelSelections: [{ capability: "image.generation", modelId: "m-1", modelVersion: "1.2.0" }],
    workflowSelections: [],
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
  };

  it("validates a complete manifest", () => {
    const parsed = ProductionManifest.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it("rejects a manifest without model selections", () => {
    const parsed = ProductionManifest.safeParse({ ...valid, modelSelections: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("event envelope", () => {
  it("builds a valid envelope with defaults", () => {
    const envelope = makeEnvelope({
      eventId: "evt-1",
      name: "job.completed",
      payload: { jobId: "job-1" },
    });
    expect(DomainEventEnvelope.safeParse(envelope).success).toBe(true);
  });

  it("rejects unknown event names", () => {
    const parsed = DomainEventEnvelope.safeParse({
      eventId: "evt-2",
      name: "not.an.event",
      occurredAt: new Date().toISOString(),
      correlation: {},
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });
});

describe("audience rules", () => {
  it("requires email verification for comment and share, not like", () => {
    expect(requiresEmailVerification("comment")).toBe(true);
    expect(requiresEmailVerification("share")).toBe(true);
    expect(requiresEmailVerification("like")).toBe(false);
  });

  it("requires email verification for message (T1: contracts align with @stratifit/auth)", () => {
    expect(requiresEmailVerification("message")).toBe(true);
  });

  it("validates message requests", () => {
    expect(
      MessageRequest.safeParse({ creatorHandle: "ava-ai", body: "I want a website like this." })
        .success,
    ).toBe(true);
    expect(MessageRequest.safeParse({ creatorHandle: "Ava AI", body: "hi" }).success).toBe(false);
  });
});
