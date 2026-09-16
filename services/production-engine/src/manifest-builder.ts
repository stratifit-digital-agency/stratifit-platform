import type { ProductionManifest } from "@stratifit/contracts";

/**
 * Manifest builder — assembles the approved, executable contract handed from
 * planning to execution after the gate passes and approvals are granted.
 */

export interface ManifestDraftInput {
  readonly organizationId: string;
  readonly productionId: string;
  readonly approvedBy: string;
  readonly sceneCount: number;
  readonly shotCount: number;
  readonly modelSelections: ProductionManifest["modelSelections"];
  readonly workflowSelections: ProductionManifest["workflowSelections"];
  readonly computeEstimate: ProductionManifest["computeEstimate"];
  readonly rights: ProductionManifest["rights"];
  readonly safety: ProductionManifest["safety"];
  readonly plan: Record<string, unknown>;
}

export const buildManifest = (input: ManifestDraftInput): ProductionManifest => ({
  manifestVersion: "1",
  organizationId: input.organizationId,
  productionId: input.productionId,
  createdAt: new Date().toISOString(),
  approvedBy: input.approvedBy,
  sceneCount: input.sceneCount,
  shotCount: input.shotCount,
  modelSelections: input.modelSelections,
  workflowSelections: input.workflowSelections,
  computeEstimate: input.computeEstimate,
  rights: input.rights,
  safety: input.safety,
  plan: input.plan,
});
