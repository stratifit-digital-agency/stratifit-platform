import { z } from "zod";
import {
  ManifestComputeEstimate,
  ManifestModelSelection,
  ManifestRights,
  ManifestWorkflowSelection,
} from "./manifest";

/**
 * Production domain contracts (Stage 2.6 — Production Domain Foundation,
 * decisions D2.6-1..D2.6-4).
 *
 * Transport validation for the /api/control/projects and
 * /api/control/productions BFF surface. These are request shapes only —
 * capability checks (`production.plan`, `production.approve`), organization
 * boundaries, the production state machine, and the gate/manifest invariants
 * remain server-side in services/production-engine. Event vocabulary remains
 * the existing production.* names; no new events are introduced here.
 */

/** DOMAIN_MODEL section 7 ProductionKind enumeration. */
export const ProductionKind = z.enum([
  "film",
  "series",
  "episode",
  "short",
  "comedy",
  "skit",
  "music",
  "documentary",
  "live",
  "trailer",
  "advertisement",
]);
export type ProductionKind = z.infer<typeof ProductionKind>;

export const ProjectSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case");
export type ProjectSlug = z.infer<typeof ProjectSlug>;

export const CreateProjectRequest = z.object({
  slug: ProjectSlug,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const CreateProductionRequest = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(300),
  kind: ProductionKind,
});
export type CreateProductionRequest = z.infer<typeof CreateProductionRequest>;

/**
 * Plan document (D2.6-2): the structured, schema-validated planning payload
 * stored inline as jsonb (no script/storage-reference subsystem in 2.6).
 * The gate-relevant fields are required so `evaluateProductionGate` can run
 * against any recorded version; the catchall keeps planning-owned extension
 * fields legal (DOMAIN_MODEL section 7: the plan payload is opaque to other
 * contexts).
 */
export const ProductionPlanDocument = z
  .object({
    sceneCount: z.number().int().nonnegative(),
    shotCount: z.number().int().nonnegative(),
    modelSelections: z.array(ManifestModelSelection),
    workflowSelections: z.array(ManifestWorkflowSelection),
    computeEstimate: ManifestComputeEstimate,
    rights: ManifestRights,
    safety: z.object({ moderationRequired: z.boolean() }),
  })
  .catchall(z.unknown());
export type ProductionPlanDocument = z.infer<typeof ProductionPlanDocument>;

export const RecordPlanVersionRequest = z.object({
  planDocument: ProductionPlanDocument,
});
export type RecordPlanVersionRequest = z.infer<typeof RecordPlanVersionRequest>;

/** Gate inputs snapshot (DOMAIN_MODEL section 7 Gate Decision Record). */
export const GateEvaluationRequest = z.object({
  budgetUsd: z.number().positive().optional(),
  moderationPlanned: z.boolean().optional(),
});
export type GateEvaluationRequest = z.infer<typeof GateEvaluationRequest>;
