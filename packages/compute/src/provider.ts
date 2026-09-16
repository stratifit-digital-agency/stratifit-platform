/**
 * Compute abstraction.
 *
 * Compute Manager → ComputeProvider → RunPod (and future providers). RunPod
 * is a PROVIDER behind this abstraction, not the platform's architecture.
 * No live RunPod calls exist in this foundation: the adapter stub requires an
 * explicit API key injected at construction and refuses to run without one.
 */

export interface ComputeAllocationRequest {
  readonly gpuClass: string;
  readonly vramGb: number;
  readonly workers: number;
  readonly concurrency: number;
  readonly estimatedRuntimeSeconds: number;
  readonly storageMb: number;
}

export interface ComputeAllocation {
  readonly allocationId: string;
  readonly provider: string;
  readonly gpuClass: string;
  readonly startedAt: string;
}

export interface ComputeUsageRecord {
  readonly allocationId: string;
  readonly actualRuntimeSeconds: number;
  readonly actualCostUsd: number;
}

export interface ComputeProvider {
  readonly name: string;
  allocate(request: ComputeAllocationRequest): Promise<ComputeAllocation>;
  release(allocationId: string): Promise<void>;
  /** Actual usage captured for estimate-vs-actual improvement over time. */
  usage(allocationId: string): Promise<ComputeUsageRecord | undefined>;
}

/**
 * Mock provider for development and tests — allocates nothing, records
 * synthetic usage. No network, no credentials.
 */
export class MockComputeProvider implements ComputeProvider {
  readonly name = "mock";
  private readonly allocations = new Map<string, { request: ComputeAllocationRequest; startedAt: string }>();
  private counter = 0;

  async allocate(request: ComputeAllocationRequest): Promise<ComputeAllocation> {
    this.counter += 1;
    const allocationId = `mock-alloc-${this.counter}`;
    this.allocations.set(allocationId, { request, startedAt: new Date().toISOString() });
    return {
      allocationId,
      provider: this.name,
      gpuClass: request.gpuClass,
      startedAt: this.allocations.get(allocationId)?.startedAt ?? new Date().toISOString(),
    };
  }

  async release(allocationId: string): Promise<void> {
    this.allocations.delete(allocationId);
  }

  async usage(allocationId: string): Promise<ComputeUsageRecord | undefined> {
    const alloc = this.allocations.get(allocationId);
    if (!alloc) return undefined;
    return {
      allocationId,
      actualRuntimeSeconds: alloc.request.estimatedRuntimeSeconds,
      actualCostUsd: 0,
    };
  }
}

/**
 * RunPod adapter — STUB ONLY in this foundation.
 *
 * - Requires `apiKey` injected explicitly at construction (server-side env
 *   only; never bundled for the browser).
 * - All operations throw until the execution phase implements them; nothing
 *   here performs network I/O today.
 */
export class RunPodComputeProviderStub implements ComputeProvider {
  readonly name = "runpod";
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("RunPodComputeProviderStub requires an API key");
  }

  async allocate(): Promise<ComputeAllocation> {
    throw new Error("RunPod provider is not implemented in the foundation phase");
  }
  async release(): Promise<void> {
    throw new Error("RunPod provider is not implemented in the foundation phase");
  }
  async usage(): Promise<ComputeUsageRecord | undefined> {
    throw new Error("RunPod provider is not implemented in the foundation phase");
  }
}

/**
 * Compute Manager: plans, allocates via the selected provider, and records
 * usage so estimates improve against actuals over time.
 */
export class ComputeManager {
  constructor(private readonly provider: ComputeProvider) {}

  /** Pure estimate computation — no allocation, no side effects. */
  static estimate(request: ComputeAllocationRequest): {
    estimatedCostUsd: number;
    gpuSeconds: number;
  } {
    const gpuSeconds = request.workers * request.estimatedRuntimeSeconds;
    // Placeholder pricing; real pricing arrives with provider integration.
    const estimatedCostUsd = Number((gpuSeconds * 0.0001).toFixed(4));
    return { estimatedCostUsd, gpuSeconds };
  }

  async allocate(request: ComputeAllocationRequest): Promise<ComputeAllocation> {
    return this.provider.allocate(request);
  }

  async recordUsage(record: ComputeUsageRecord): Promise<ComputeUsageRecord> {
    return record; // persistence arrives with the domain schema phase
  }
}
