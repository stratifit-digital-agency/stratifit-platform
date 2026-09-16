import { describe, expect, it } from "vitest";
import type { ModelInvocation } from "./model";
import { InMemoryModelRegistry, type ModelAdapter } from "./model";

const fakeAdapter = (id: string, kind: ModelAdapter["descriptor"]["kind"]): ModelAdapter => ({
  descriptor: { id, version: "1.0.0", kind, vendor: "test" },
  async invoke(): Promise<ModelInvocation> {
    return {
      descriptor: this.descriptor,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      outputRef: `test://${id}/out`,
    };
  },
});

describe("InMemoryModelRegistry", () => {
  it("registers, lists, and routes by capability", () => {
    const registry = new InMemoryModelRegistry();
    const image = fakeAdapter("img-model", "image.generation");
    const voice = fakeAdapter("voice-model", "voice.synthesis");
    registry.register(image);
    registry.register(voice);

    expect(registry.list()).toHaveLength(2);
    expect(registry.find("image.generation")).toEqual([image.descriptor]);
    expect(registry.route("image.generation")).toBe(image);
    expect(registry.route("video.generation")).toBeUndefined();
  });
});
