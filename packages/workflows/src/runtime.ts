/**
 * Workflow abstraction.
 *
 * Production Engine → Workflow Contract → Workflow Registry → Workflow
 * Runtime. ComfyUI is one possible runtime behind this abstraction and is
 * deliberately never referenced here; the platform must support another
 * runtime later without redesign.
 */

export interface WorkflowDefinition {
  /** Opaque engine-specific payload (e.g., a graph); runtime interprets it. */
  readonly definition: unknown;
}

export interface WorkflowContract {
  readonly id: string;
  readonly version: string;
  /** Capability kinds this workflow can execute. */
  readonly supports: readonly string[];
  readonly definition: WorkflowDefinition;
}

export interface WorkflowRunHandle {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
}

export interface WorkflowRuntime {
  readonly name: string;
  /** Begin executing a workflow; runtimes report progress/failure async. */
  start(workflow: WorkflowContract, input: Record<string, unknown>): Promise<WorkflowRunHandle>;
}

export interface WorkflowRegistry {
  register(workflow: WorkflowContract): void;
  get(id: string, version?: string): WorkflowContract | undefined;
  list(): readonly WorkflowContract[];
}

export class InMemoryWorkflowRegistry implements WorkflowRegistry {
  private readonly byId = new Map<string, WorkflowContract[]>();

  register(workflow: WorkflowContract): void {
    const existing = this.byId.get(workflow.id) ?? [];
    this.byId.set(workflow.id, [...existing, workflow]);
  }

  get(id: string, version?: string): WorkflowContract | undefined {
    const versions = this.byId.get(id);
    if (!versions) return undefined;
    if (version) return versions.find((w) => w.version === version);
    return versions[versions.length - 1];
  }

  list(): readonly WorkflowContract[] {
    return [...this.byId.values()].flat();
  }
}
