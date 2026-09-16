import type { CapabilityKind, CapabilityRequest } from "@stratifit/contracts";

/**
 * Model abstraction.
 *
 * Production Engine → Capability Contract → Model Router → Model Adapter →
 * Selected Model. No specific vendor (RunPod, ComfyUI, or any provider)
 * appears anywhere in this package. Models evolve without rewriting the
 * production engine; versions remain identifiable for reproducibility.
 */

export interface ModelDescriptor {
  readonly id: string;
  readonly version: string;
  readonly kind: CapabilityKind;
  /** Human-readable vendor label for operator UIs only. */
  readonly vendor: string;
}

/** A single model execution result. Provenance is captured by callers. */
export interface ModelInvocation {
  readonly descriptor: ModelDescriptor;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outputRef: string; // storage key reference — binaries live in object storage
}

export interface ModelAdapter {
  readonly descriptor: ModelDescriptor;
  /** Execute a capability request. Implementations enforce their own auth. */
  invoke(request: CapabilityRequest): Promise<ModelInvocation>;
}

export interface ModelRegistry {
  register(adapter: ModelAdapter): void;
  list(): readonly ModelDescriptor[];
  find(kind: CapabilityKind): readonly ModelDescriptor[];
}

export interface ModelRouter {
  /** Select an adapter for a capability; selection policy is registry-order for now. */
  route(kind: CapabilityKind): ModelAdapter | undefined;
}

/** In-memory registry + router; durable registry arrives with DOMAIN_MODEL.md. */
export class InMemoryModelRegistry implements ModelRegistry, ModelRouter {
  private readonly adapters: ModelAdapter[] = [];

  register(adapter: ModelAdapter): void {
    this.adapters.push(adapter);
  }

  list(): readonly ModelDescriptor[] {
    return this.adapters.map((a) => a.descriptor);
  }

  find(kind: CapabilityKind): readonly ModelDescriptor[] {
    return this.adapters.filter((a) => a.descriptor.kind === kind).map((a) => a.descriptor);
  }

  route(kind: CapabilityKind): ModelAdapter | undefined {
    return this.adapters.find((a) => a.descriptor.kind === kind);
  }
}
