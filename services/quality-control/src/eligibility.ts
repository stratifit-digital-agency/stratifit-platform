/**
 * Publication-eligibility pure function (Stage 2.11, D2.11-6).
 *
 * The sanctioned QC → Publishing handoff seam (DATA_FLOW SUGGESTION 3,
 * mirroring production-engine's evaluateProductionGate): publishing never
 * implements QC rules — it consumes this verdict. DM invariant 1: a
 * publication can only proceed from a subject whose QC review state is
 * `approved`.
 *
 * PURE: no side effects, no database access, no imports beyond ./types,
 * testable in isolation, independent of the Publishing implementation.
 * Anything uncertain FAILS CLOSED (eligible stays false with a reason).
 */
import type {
  QcCheckRecord,
  QcIssueRecord,
  QcResultRecord,
  QcReviewRecord,
} from "./types";

export interface PublicationEligibility {
  /** True ONLY when every gate below passes. Uncertainty is never eligible. */
  readonly eligible: boolean;
  /** Human-readable reasons for every failed gate (empty when eligible). */
  readonly reasons: readonly string[];
}

/** Latest result for a check by (evaluated_at DESC, id DESC) — the approved ordering. */
export const latestResultForCheck = (
  results: readonly QcResultRecord[],
  checkId: string,
): QcResultRecord | null => {
  const sorted = [...results]
    .filter((r) => r.checkId === checkId)
    .sort((a, b) => (a.evaluatedAt === b.evaluatedAt ? (a.id > b.id ? -1 : 1) : a.evaluatedAt > b.evaluatedAt ? -1 : 1));
  return sorted[0] ?? null;
};

export const evaluatePublicationEligibility = (
  review: Pick<QcReviewRecord, "status" | "subjectKind">,
  results: readonly QcResultRecord[],
  issues: readonly QcIssueRecord[],
  requiredChecks: readonly Pick<QcCheckRecord, "id" | "required" | "status" | "appliesToKind">[],
): PublicationEligibility => {
  const reasons: string[] = [];

  // Gate 1 (DM invariant 1): the review itself must be approved. Any other
  // state — pending, in_review, rejected, changes_requested — fails closed.
  if (review.status !== "approved") {
    reasons.push(`review status is ${review.status}, not approved`);
  }

  // Gate 2: every required + ACTIVE check for this subject kind must have a
  // latest result. Archived checks are excluded from NEW gating evidence
  // (D2.11-7); a check that applies to a different subject kind is skipped.
  const applicableRequired = requiredChecks.filter(
    (c) => c.required && c.status === "active" && c.appliesToKind === review.subjectKind,
  );
  for (const check of applicableRequired) {
    const latest = latestResultForCheck(results, check.id);
    if (!latest) {
      reasons.push(`required check ${check.id} has no result`);
      continue;
    }
    // Gate 3: every such latest result must be a pass (warn/fail/skipped all block).
    if (latest.outcome !== "pass") {
      reasons.push(`required check ${check.id} latest outcome is ${latest.outcome}`);
    }
  }

  // Gate 4: no unresolved blocker issues anywhere on this review's results.
  for (const issue of issues) {
    if (issue.severity === "blocker" && issue.resolution === "open") {
      reasons.push(`unresolved blocker issue ${issue.id}`);
    }
  }

  return { eligible: reasons.length === 0, reasons };
};
