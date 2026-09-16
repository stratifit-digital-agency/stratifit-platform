import { describe, expect, it } from "vitest";
import { ComputeManager, MockComputeProvider, RunPodComputeProviderStub } from "./provider";

const request = {
  gpuClass: "rtx-4090",
  vramGb: 24,
  workers: 2,
  concurrency: 1,
  estimatedRuntimeSeconds: 120,
  storageMb: 512,
};

describe("MockComputeProvider", () => {
  it("allocates and returns unique allocation IDs", async () => {
    const provider = new MockComputeProvider();
    const a = await provider.allocate(request);
    const b = await provider.allocate(request);
    expect(a.allocationId).not.toBe(b.allocationId);
    expect(a.provider).toBe("mock");
  });

  it("reports usage only for live allocations", async () => {
    const provider = new MockComputeProvider();
    const a = await provider.allocate(request);
    expect((await provider.usage(a.allocationId))?.actualRuntimeSeconds).toBe(120);
    await provider.release(a.allocationId);
    expect(await provider.usage(a.allocationId)).toBeUndefined();
  });
});

describe("RunPodComputeProviderStub", () => {
  it("refuses construction without an API key", () => {
    expect(() => new RunPodComputeProviderStub("")).toThrow();
  });

  it("never performs live operations in the foundation", async () => {
    const provider = new RunPodComputeProviderStub("test-key");
    await expect(provider.allocate()).rejects.toThrow(/not implemented/);
  });
});

describe("ComputeManager", () => {
  it("estimates cost purely from the request", () => {
    const est = ComputeManager.estimate(request);
    expect(est.gpuSeconds).toBe(240);
    expect(est.estimatedCostUsd).toBeCloseTo(0.024, 4);
  });

  it("allocates through the configured provider", async () => {
    const provider = new MockComputeProvider();
    const manager = new ComputeManager(provider);
    const alloc = await manager.allocate(request);
    expect(alloc.provider).toBe("mock");
  });
});
