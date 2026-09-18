/**
 * QC domain service (Stage 2.11, approved decisions D2.11-1..D2.11-8).
 *
 * Operator-originated commands enforce, in order: capability
 * (`production.approve`, D2.11-8 — no new permission) -> org boundary
 * (actor.organizationId is the SOLE org authority) -> subject ownership via
 * narrow read-only upstream ports (publication FAILS CLOSED, D2.11-2) ->
 * deterministic validation -> state-machine validity (DM section 32.5) ->
 * persistence + same-transaction audit -> post-commit event publication
 * (exactly qc.requested / qc.approved / qc.rejected, D2.11-4).
 *
 * HARD DOMAIN-SEPARATION RULE: QC never mutates asset approval state. There
 * is no Asset-mutation dependency here; qc.approved does NOT approve an
 * asset — assets.approval_state remains owned by the Asset Domain
 * (Stage 2.10), full stop.
 *
 * D2.4-1 (reused): actor-originated mutations and their audit records
 * commit inside the SAME database transaction via
 * `QcRepository.runInTransaction` — a crash before COMMIT rolls back BOTH,
 * and a successful mutation cannot commit without its audit record.
 * Repositories without transaction support fail closed unless the TEST-ONLY
 * `allowSequentialAudit` flag is set; production composition roots never
 * set it. recordResult follows the D2.10-4 conditional precedent: audited
 * when an operator identity exists, never fabricating one for
 * execution/service actors.
 */
import { randomUUID } from "node:crypto";
import { emitEvent, InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  QcActor,
  QcAuditAppend,
  QcCheckRecord,
  QcCommandErrorReason,
  QcCommandResult,
  QcDecision,
  QcIssueRecord,
  QcRepository,
  QcRequestOutcome,
  QcResolvedSubjectPort,
  QcResultRecord,
  QcReviewDecisionRecord,
  QcReviewRecord,
  QcReviewStatus,
  QcSubjectKind,
  QcTransaction,
  RecordDecisionInput,
  RecordResultInput,
  RegisterQcCheckInput,
  RequestReviewInput,
  ResolveIssueInput,
  UpdateQcCheckInput,
} from "./types";
import { QC_REVIEW_TRANSITIONS, TERMINAL_QC_REVIEW_STATUSES } from "./types";

const err = <T>(reason: QcCommandErrorReason, message: string): QcCommandResult<T> => ({
  ok: false as const,
  error: { reason, message },
});

const ok = <T>(value: T): QcCommandResult<T> => ({ ok: true as const, value });

const isUUID = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** The single capability for every QC operation (D2.11-8). */
const QC_CAPABILITY = "production.approve" as const;

const requireCapability = (actor: QcActor): QcCommandResult<never> | null =>
  actor.capabilities.includes(QC_CAPABILITY)
    ? null
    : err("missing_capability", `QC operations require the ${QC_CAPABILITY} capability`);

/** Map a decision to its target state (DM section 32.5). */
const targetFor = (decision: QcDecision): QcReviewStatus =>
  decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "changes_requested";

export interface QcServiceDeps {
  repository: QcRepository;
  /**
   * D2.11-2: resolves subject ownership through narrow read-only upstream
   * ports. asset_version/generation/production must resolve inside the
   * actor's organization; publication subjects return
   * `{ kind: "publication", unsupported: true }` and FAIL CLOSED; a
   * cross-org or absent subject resolves to null (IDOR-safe).
   */
  resolveSubject: QcResolvedSubjectPort;
  /** Defaults to an in-process publisher with no handlers (Stage-1 semantics). */
  publisher?: EventPublisher;
  /** Fallback audit seam (used only when the repository has no transaction support). */
  auditAppend?: QcAuditAppend;
  /**
   * TEST-ONLY: permit the sequential (non-transactional) audit fallback for
   * repositories without `runInTransaction`. Production composition roots
   * never set it — there the service fail-closes instead (D2.4-1).
   */
  allowSequentialAudit?: boolean;
  eventIdFactory?: () => string;
}

export interface QcService {
  // ---- check definitions (operator-originated, audited) ----
  registerQcCheck(actor: QcActor, input: RegisterQcCheckInput): Promise<QcCommandResult<QcCheckRecord>>;
  updateQcCheck(actor: QcActor, checkId: string, input: UpdateQcCheckInput): Promise<QcCommandResult<QcCheckRecord>>;

  // ---- review lifecycle ----
  requestReview(actor: QcActor, input: RequestReviewInput): Promise<QcCommandResult<QcRequestOutcome>>;
  submitForReview(actor: QcActor, reviewId: string): Promise<QcCommandResult<QcReviewRecord>>;
  /** changes_requested reviews re-enter pending via this reset edge (DM section 32.5). */
  resetChangesRequested(actor: QcActor, reviewId: string): Promise<QcCommandResult<QcReviewRecord>>;
  recordDecision(
    actor: QcActor,
    reviewId: string,
    input: RecordDecisionInput,
  ): Promise<QcCommandResult<{ review: QcReviewRecord; decision: QcReviewDecisionRecord }>>;

  // ---- results & issues ----
  recordResult(actor: QcActor, reviewId: string, input: RecordResultInput): Promise<QcCommandResult<QcResultRecord>>;
  resolveIssue(actor: QcActor, issueId: string, input: ResolveIssueInput): Promise<QcCommandResult<QcIssueRecord>>;

  // ---- org-scoped queries ----
  getReview(
    actor: QcActor,
    reviewId: string,
  ): Promise<
    QcCommandResult<{
      review: QcReviewRecord;
      results: QcResultRecord[];
      decisions: QcReviewDecisionRecord[];
      issues: QcIssueRecord[];
    }>
  >;
  listReviews(
    actor: QcActor,
    filter?: { status?: QcReviewStatus; subjectKind?: QcSubjectKind },
  ): Promise<QcCommandResult<QcReviewRecord[]>>;
}

export const createQcService = (deps: QcServiceDeps): QcService => {
  const repo = deps.repository;
  const publisher: EventPublisher = deps.publisher ?? new InProcessEventPublisher();
  const nextEventId = deps.eventIdFactory ?? randomUUID;

  const emit = async (
    name: "qc.requested" | "qc.approved" | "qc.rejected",
    payload: Record<string, unknown>,
    correlation: { organizationId: string },
  ) => {
    await emitEvent(publisher, {
      eventId: nextEventId(),
      name,
      correlation: { organizationId: correlation.organizationId },
      payload,
    });
  };

  const auditEntry = (
    actor: QcActor,
    action: string,
    targetType: Parameters<QcAuditAppend>[0]["targetType"],
    targetId: string,
    metadata?: Record<string, unknown>,
  ) => ({
    actorId: actor.operatorId ?? "system",
    action,
    targetType,
    targetId,
    ...(metadata !== undefined ? { metadata } : {}),
    organizationId: actor.organizationId,
    correlationId: actor.correlationId ?? null,
  });

  const fallbackAudit = deps.auditAppend;

  /**
   * D2.4-1 shared transactional path. With a transactional repository, `work`
   * composes the mutation AND its audit append on the tx (the caller calls
   * tx.appendAudit inside `work`); without one, production FAILS CLOSED and
   * the sequential fallback is available only for explicitly enabled tests.
   */
  const runWithAudit = async <T>(
    actor: QcActor,
    action: string,
    targetType: Parameters<QcAuditAppend>[0]["targetType"],
    work: (tx: QcTransaction) => Promise<{ value: T; targetId: string; metadata?: Record<string, unknown> }>,
    opts?: { skipAudit?: boolean },
  ): Promise<T> => {
    const runInTransaction = repo.runInTransaction;
    if (!runInTransaction) {
      if (!deps.allowSequentialAudit || !fallbackAudit) {
        throw new Error(
          "D2.4-1 violation: QC mutations cannot commit without a same-transaction audit " +
            "record. (The sequential audit fallback is test-only and must be " +
            "enabled explicitly via allowSequentialAudit.)",
        );
      }
      const { value, targetId, metadata } = await work(directTx());
      if (!opts?.skipAudit) await fallbackAudit(auditEntry(actor, action, targetType, targetId, metadata));
      return value;
    }
    // Transactional path: `work` composes mutation + tx.appendAudit itself.
    const result = await runInTransaction(async (tx) => {
      const { value, targetId, metadata } = await work(tx);
      if (!opts?.skipAudit) {
        await tx.appendAudit(auditEntry(actor, action, targetType, targetId, metadata));
      }
      return value;
    });
    return result;
  };

  const directTx = (): QcTransaction => ({
    insertCheck: (input) => repo.insertCheck(input),
    updateCheck: (checkId, patch) => repo.updateCheck(checkId, patch),
    insertReview: (input) => repo.insertReview(input),
    updateReviewStatus: (reviewId, status) => repo.updateReviewStatus(reviewId, status),
    insertDecision: (input) => repo.insertDecision(input),
    insertResult: (input) => repo.insertResult(input),
    resolveIssue: (issueId, input) => repo.resolveIssue(issueId, input),
    appendAudit: (entry) => fallbackAudit!(entry),
  });

  const isTerminal = (status: QcReviewStatus) => TERMINAL_QC_REVIEW_STATUSES.includes(status);

  return {
    async registerQcCheck(actor, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (!actor.operatorId) return err("invalid_request", "check registration requires an operator identity");
      const name = input.name.trim();
      if (name.length < 1 || name.length > 128) {
        return err("invalid_request", "name must be a non-empty string of at most 128 characters");
      }
      if (input.parameters !== undefined && (typeof input.parameters !== "object" || Array.isArray(input.parameters))) {
        return err("invalid_request", "parameters must be a JSON object");
      }
      // Org-unique backstop: duplicate names are deterministic conflicts.
      const existing = await repo.findCheckByName(actor.organizationId, name);
      if (existing) {
        return err("invalid_request", `a check named ${name} already exists in your organization`);
      }
      const check = await runWithAudit(actor, "qc.qc_check_registered", "qc_check", async (tx) => {
        const value = await tx.insertCheck({
          orgId: actor.organizationId,
          name,
          appliesToKind: input.appliesToKind,
          checkType: input.checkType,
          parameters: input.parameters ?? {},
          required: input.required ?? true,
        });
        return { value, targetId: value.id, metadata: { name, appliesToKind: value.appliesToKind } };
      });
      return ok(check);
    },

    async updateQcCheck(actor, checkId, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (!actor.operatorId) return err("invalid_request", "check updates require an operator identity");
      const check = await repo.findCheckById(actor.organizationId, checkId);
      if (!check) return err("check_not_found", "check does not exist in your organization");
      const updated = await runWithAudit(actor, "qc.qc_check_updated", "qc_check", async (tx) => {
        const value = await tx.updateCheck(check.id, input);
        return { value, targetId: value.id, metadata: { name: check.name, from: check.status, to: value.status } };
      });
      return ok(updated);
    },

    async requestReview(actor, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const orgId = actor.organizationId;
      if (!isUUID(input.subjectRef)) {
        return err("invalid_request", "subjectRef must be a UUID");
      }
      // D2.11-2: subject ownership validated through narrow read-only ports.
      // A cross-org subject is indistinguishable from an absent one
      // (IDOR-safe); publication subjects FAIL CLOSED (durable Publishing
      // does not exist yet).
      const resolved = await deps.resolveSubject(orgId, input.subjectKind, input.subjectRef);
      if (resolved?.kind === "publication") {
        return err(
          "subject_unsupported",
          "publication subjects are not yet QC-reviewable (durable Publishing does not exist)",
        );
      }
      if (!resolved) {
        return err("subject_not_found", "subject does not exist in your organization");
      }
      // Deterministic dedupe: one lifecycle per subject (unique backstop).
      const existing = await repo.findReviewBySubject(orgId, input.subjectKind, input.subjectRef);
      if (existing) {
        return ok({ review: existing, deduplicated: true });
      }
      const review = await runWithAudit(actor, "qc.qc_review_requested", "qc_review", async (tx) => {
        const value = await tx.insertReview({
          orgId,
          subjectKind: input.subjectKind,
          subjectRef: input.subjectRef,
          requestedBy: actor.operatorId,
        });
        return { value, targetId: value.id, metadata: { subjectKind: value.subjectKind, subjectRef: value.subjectRef } };
      });
      // Post-commit only — a failed transaction never publishes an event.
      await emit(
        "qc.requested",
        { reviewId: review.id, subjectKind: review.subjectKind, subjectRef: review.subjectRef },
        { organizationId: orgId },
      );
      return ok({ review, deduplicated: false });
    },

    async submitForReview(actor, reviewId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (!actor.operatorId) return err("invalid_request", "submitting a review requires an operator identity");
      const review = await repo.findReviewById(reviewId);
      if (!review || review.orgId !== actor.organizationId) {
        return err("review_not_found", "review does not exist in your organization");
      }
      if (!QC_REVIEW_TRANSITIONS[review.status].includes("in_review")) {
        return err("invalid_transition", `cannot submit a ${review.status} review for review`);
      }
      const updated = await runWithAudit(actor, "qc.qc_review_submitted", "qc_review", async (tx) => {
        const value = await tx.updateReviewStatus(review.id, "in_review");
        return { value, targetId: value.id, metadata: { from: review.status, to: value.status } };
      });
      return ok(updated);
    },

    async resetChangesRequested(actor, reviewId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (!actor.operatorId) return err("invalid_request", "resetting a review requires an operator identity");
      const review = await repo.findReviewById(reviewId);
      if (!review || review.orgId !== actor.organizationId) {
        return err("review_not_found", "review does not exist in your organization");
      }
      if (!QC_REVIEW_TRANSITIONS[review.status].includes("pending")) {
        return err("invalid_transition", `cannot reset a ${review.status} review to pending`);
      }
      const updated = await runWithAudit(actor, "qc.qc_review_reset", "qc_review", async (tx) => {
        const value = await tx.updateReviewStatus(review.id, "pending");
        return { value, targetId: value.id, metadata: { from: review.status, to: value.status } };
      });
      return ok(updated);
    },

    async recordDecision(actor, reviewId, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (!actor.operatorId) return err("invalid_request", "recording a decision requires an operator identity");
      const review = await repo.findReviewById(reviewId);
      if (!review || review.orgId !== actor.organizationId) {
        return err("review_not_found", "review does not exist in your organization");
      }
      const reason = input.reason?.trim() ?? null;
      if (input.decision !== "approve" && (!reason || reason.length > 2048)) {
        return err(
          "invalid_request",
          "reject and changes_requested decisions require a reason of at most 2048 characters",
        );
      }
      if (isTerminal(review.status)) {
        return err("decision_conflict", `review is already ${review.status} (terminal)`);
      }
      if (!QC_REVIEW_TRANSITIONS[review.status].includes(targetFor(input.decision))) {
        return err("invalid_transition", `cannot record ${input.decision} on a ${review.status} review`);
      }
      // State transition + immutable decision record + audit commit in ONE
      // transaction (D2.11-3 + DM section 32.5: decision records are
      // immutable and always accompany the state change they produced).
      const runInTransaction = repo.runInTransaction;
      if (!runInTransaction) {
        throw new Error(
          "D2.4-1 violation: decisions require a transactional repository so the immutable " +
            "decision record and the state transition commit atomically",
        );
      }
      const result = await runInTransaction(async (tx) => {
        const decision = await tx.insertDecision({
          orgId: review.orgId,
          reviewId: review.id,
          decision: input.decision,
          reviewerOperatorId: actor.operatorId!,
          reason,
          capabilityUsed: QC_CAPABILITY,
        });
        const updated = await tx.updateReviewStatus(review.id, targetFor(input.decision));
        await tx.appendAudit(
          auditEntry(actor, "qc.qc_decision_recorded", "qc_review_decision", decision.id, {
            reviewId: review.id,
            decision: input.decision,
            from: review.status,
            to: updated.status,
          }),
        );
        return { review: updated, decision };
      });
      // D2.11-4: exactly these two decision events exist. changes_requested
      // deliberately emits NO event (state + audit carry the transition).
      if (input.decision === "approve") {
        await emit(
          "qc.approved",
          {
            reviewId: result.review.id,
            decisionId: result.decision.id,
            subjectKind: result.review.subjectKind,
            subjectRef: result.review.subjectRef,
          },
          { organizationId: result.review.orgId },
        );
      } else if (input.decision === "reject") {
        await emit(
          "qc.rejected",
          {
            reviewId: result.review.id,
            decisionId: result.decision.id,
            subjectKind: result.review.subjectKind,
            subjectRef: result.review.subjectRef,
            reason: reason ?? "",
          },
          { organizationId: result.review.orgId },
        );
      }
      return ok(result);
    },

    async recordResult(actor, reviewId, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const review = await repo.findReviewById(reviewId);
      if (!review || review.orgId !== actor.organizationId) {
        return err("review_not_found", "review does not exist in your organization");
      }
      if (isTerminal(review.status)) {
        return err("invalid_transition", `cannot record results on a ${review.status} (terminal) review`);
      }
      const check = await repo.findCheckById(actor.organizationId, input.checkId);
      if (!check) return err("check_not_found", "check does not exist in your organization");
      if (check.appliesToKind !== review.subjectKind) {
        return err("invalid_request", `check applies to ${check.appliesToKind} subjects, not ${review.subjectKind}`);
      }
      if (check.status === "archived") {
        return err("check_archived", "archived checks cannot be attached to new results (D2.11-7)");
      }
      if (input.evaluatedBy === "automated" && !input.ruleRef) {
        return err("invalid_request", "automated results require ruleRef provenance");
      }
      // D2.10-4 conditional precedent: audit when an operator identity
      // exists; never fabricate one for execution/service actors.
      const audited = actor.operatorId != null;
      const result = await runWithAudit(
        actor,
        "qc.qc_result_recorded",
        "qc_result",
        async (tx) => {
          const value = await tx.insertResult({
            orgId: review.orgId,
            reviewId: review.id,
            checkId: check.id,
            outcome: input.outcome,
            evaluatedBy: input.evaluatedBy,
            ruleRef: input.ruleRef ?? null,
            details: input.details ?? {},
          });
          return { value, targetId: value.id, metadata: { outcome: value.outcome, evaluatedBy: value.evaluatedBy } };
        },
        { skipAudit: !audited },
      );
      return ok(result);
    },

    async resolveIssue(actor, issueId, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (!actor.operatorId) return err("invalid_request", "resolving an issue requires an operator identity");
      const issue = await repo.findIssueById(issueId);
      if (!issue || issue.orgId !== actor.organizationId) {
        return err("review_not_found", "issue does not exist in your organization");
      }
      if (issue.resolution !== "open") {
        return err("resolution_conflict", `issue is already ${issue.resolution}`);
      }
      const updated = await runWithAudit(
        actor,
        input.resolution === "waived" ? "qc.qc_issue_waived" : "qc.qc_issue_resolved",
        "qc_issue",
        async (tx) => {
          const value = await tx.resolveIssue(issue.id, {
            resolution: input.resolution,
            resolvedBy: actor.operatorId!,
          });
          return { value, targetId: value.id, metadata: { from: issue.resolution, to: value.resolution } };
        },
      );
      return ok(updated);
    },

    async getReview(actor, reviewId) {
      const review = await repo.findReviewById(reviewId);
      if (!review || review.orgId !== actor.organizationId) {
        return err("review_not_found", "review does not exist in your organization");
      }
      const results = await repo.listResultsByReviewId(review.id);
      const decisions = await repo.listDecisionsByReviewId(review.id);
      const issues = await repo.listIssuesByResultIds(results.map((r) => r.id));
      return ok({ review, results, decisions, issues });
    },

    async listReviews(actor, filter) {
      return ok(await repo.listReviewsByOrg(actor.organizationId, filter));
    },
  };
};
