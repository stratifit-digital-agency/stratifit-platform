import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRegistry, type WorkflowContract } from "./runtime";

const workflow = (id: string, version: string): WorkflowContract => ({
  id,
  version,
  supports: ["image.generation"],
  definition: { definition: { nodes: [] } },
});

describe("InMemoryWorkflowRegistry", () => {
  it("returns latest version by default and specific version on demand", () => {
    const registry = new InMemoryWorkflowRegistry();
    registry.register(workflow("txt2img", "1.0.0"));
    registry.register(workflow("txt2img", "1.1.0"));

    expect(registry.get("txt2img")?.version).toBe("1.1.0");
    expect(registry.get("txt2img", "1.0.0")?.version).toBe("1.0.0");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("keeps historical versions addressable (reproducibility)", () => {
    const registry = new InMemoryWorkflowRegistry();
    registry.register(workflow("txt2img", "1.0.0"));
    registry.register(workflow("txt2img", "1.1.0"));
    expect(registry.list()).toHaveLength(2);
  });
});
