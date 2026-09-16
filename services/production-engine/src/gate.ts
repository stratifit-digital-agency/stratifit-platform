import type { ProductionManifest } from "@stratifit/contracts";

/**
 * Production Gate — pure, testable rule evaluation over a manifest draft.
 *
 * Do not allocate expensive GPU resources before required planning and
 * validation. This module performs NO side effects: no allocation, no events,
 * no persistence. Deterministic backend services call it and enforce the
 * decision.
 *
 * Gate checks (per architecture):
 * - production validity, scenes/shots present
 * - model + workflow compatibility (selections present per capability)
 * - rights confirmed (digital-human, voice)
 * - compute requirements sane (VRAM/workers/concurrency positive)
 * - estimated cost present and within budget
 * - moderation/safety requirement acknowledged
 */

export type GateIssueCode =
  | "missing_scenes"
  | "missing_shots"
  | "missing_model_selection"
  | "missing_workflow_selection"
  | "rights_not_confirmed"
  | "invalid_compute"
  | "over_budget"
  | "moderation_not_planned";

export interface GateIssue {
  readonly code: GateIssueCode;
  readonly message: string;
}

export type GateDecision =
  | { readonly passed: true; readonly issues: readonly [] }
  | { readonly passed: false; readonly issues: readonly GateIssue[] };

export interface GateInput {
  readonly manifest: ProductionManifest;
  readonly budgetUsd?: number | undefined;
  /** Set true by operators to acknowledge a required-moderation production. */
  readonly moderationPlanned?: boolean | undefined;
}

export const evaluateProductionGate = (input: GateInput): GateDecision => {
  const issues: GateIssue[] = [];
  const m = input.manifest;

  if (m.sceneCount === 0) {
    issues.push({ code: "missing_scenes", message: "production has no scenes" });
  }
  if (m.shotCount === 0) {
    issues.push({ code: "missing_shots", message: "production has no shots" });
  }
  if (m.modelSelections.length === 0) {
    issues.push({ code: "missing_model_selection", message: "no model selections" });
  }
  if (m.workflowSelections.length === 0) {
    issues.push({ code: "missing_workflow_selection", message: "no workflow selections" });
  }
  if (!m.rights.digitalHumanRightsConfirmed || !m.rights.voiceRightsConfirmed) {
    issues.push({ code: "rights_not_confirmed", message: "digital-human/voice rights unconfirmed" });
  }
  if (
    m.computeEstimate.vramGb <= 0 ||
    m.computeEstimate.workers <= 0 ||
    m.computeEstimate.concurrency <= 0 ||
    m.computeEstimate.estimatedRuntimeSeconds <= 0
  ) {
    issues.push({ code: "invalid_compute", message: "compute estimate has non-positive fields" });
  }
  if (input.budgetUsd !== undefined && m.computeEstimate.estimatedCostUsd > input.budgetUsd) {
    issues.push({
      code: "over_budget",
      message: `estimated $${m.computeEstimate.estimatedCostUsd} exceeds budget $${input.budgetUsd}`,
    });
  }
  if (m.safety.moderationRequired && input.moderationPlanned !== true) {
    issues.push({
      code: "moderation_not_planned",
      message: "moderation required but not planned",
    });
  }

  return issues.length === 0 ? { passed: true, issues: [] } : { passed: false, issues };
};
