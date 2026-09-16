import { z } from "zod";
import { asOrganizationId, asProductionId, type OrganizationId, type ProductionId } from "./ids";

/**
 * Production manifest — the approved, executable contract handed from
 * planning to execution. Created only after the Production Gate passes and
 * required approvals are granted.
 *
 * IDs are plain strings here (schema-validated); branded ID types are used by
 * service-layer code for cross-entity linkage.
 */

export const ManifestModelSelection = z.object({
  capability: z.string().min(1),
  modelId: z.string().min(1),
  modelVersion: z.string().min(1),
});

export const ManifestWorkflowSelection = z.object({
  workflowId: z.string().min(1),
  workflowVersion: z.string().min(1),
});

export const ManifestComputeEstimate = z.object({
  gpuClass: z.string().min(1),
  vramGb: z.number().positive(),
  workers: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  estimatedRuntimeSeconds: z.number().positive(),
  storageMb: z.number().positive(),
  estimatedCostUsd: z.number().nonnegative(),
});

export const ManifestRights = z.object({
  digitalHumanRightsConfirmed: z.boolean(),
  voiceRightsConfirmed: z.boolean(),
});

export const ProductionManifest = z.object({
  manifestVersion: z.string().min(1), // schema version, NOT runtime content
  organizationId: z.string().min(1),
  productionId: z.string().min(1),
  createdAt: z.string().datetime(),
  approvedBy: z.string().min(1), // operator identity at approval time
  sceneCount: z.number().int().nonnegative(),
  shotCount: z.number().int().nonnegative(),
  modelSelections: z.array(ManifestModelSelection).min(1),
  workflowSelections: z.array(ManifestWorkflowSelection),
  computeEstimate: ManifestComputeEstimate,
  rights: ManifestRights,
  safety: z.object({ moderationRequired: z.boolean() }),
  /** Opaque, schema-validated plan payload; internal structure owned by planning. */
  plan: z.record(z.string(), z.unknown()),
});

export type ManifestModelSelection = z.infer<typeof ManifestModelSelection>;
export type ManifestWorkflowSelection = z.infer<typeof ManifestWorkflowSelection>;
export type ManifestComputeEstimate = z.infer<typeof ManifestComputeEstimate>;
export type ManifestRights = z.infer<typeof ManifestRights>;
export type ProductionManifest = z.infer<typeof ProductionManifest>;

/** Cross-domain reference for downstream job/generation provenance linkage. */
export interface ManifestRef {
  readonly manifestVersion: string;
  readonly productionId: ProductionId;
  readonly organizationId: OrganizationId;
}

export const manifestRefFrom = (m: ProductionManifest): ManifestRef => ({
  manifestVersion: m.manifestVersion,
  productionId: asProductionId(m.productionId),
  organizationId: asOrganizationId(m.organizationId),
});
