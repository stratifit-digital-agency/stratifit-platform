/**
 * Unit test matrix for the QC domain service (Stage 2.11) with in-memory
 * fakes. The fake repository implements runInTransaction WITH rollback
 * semantics (snapshot/restore) so the D2.4-1 same-transaction guarantees —
 * and the fail-closed sequential fallback — are exercised exactly as the
 * production Drizzle repository behaves.
 *
 * Covered decisions: D2.11-1 (checks included), D2.11-2 (subject ports,
 * publication fail-closed), D2.11-3 (immutable decisions), D2.11-4 (three
 * events only), D2.11-6 (pure eligibility), D2.11-7 (active|archived),
 * D2.11-8 (production.approve, no new permission), D2.10-4 (conditional
 * audit precedent), and the HARD domain-separation rule (QC never mutates
 * asset approval state — the service has no such dependency at all).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  QcActor,
  QcAuditAppend,
  QcCheckRecord,
  QcCommandResult,
  QcIssueRecord,
  QcRepository,
  QcResolvedSubjectPort,
  QcResultRecord,
  QcReviewDecisionRecord,
  QcReviewRecord,
  QcTransaction,
} from "./types";
import { QC_REVIEW_TRANSITIONS, TERMINAL_QC_REVIEW_STATUSES } from "./types";
import { createQcService, type QcService } from "./service";
import { evaluatePublicationEligibility, latestResultForCheck } from "./eligibility";

let seq = 0;
const id = (_p: string) => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const actor = (overrides: Partial<QcActor> = {}): QcActor => ({
  operatorId: "op-1",
  organizationId: "org-1",
  roles: ["operator"],
  capabilities: ["production.approve", "audit.read"],
  ...overrides,
});

const otherActor = () => actor({ operatorId: "op-2", organizationId: "org-2" });

/** QcActor with NO operator identity (execution/service actor, D2.10-4). */
const serviceActor = (): QcActor => ({
  operatorId: null,
  organizationId: "org-1",
  roles: [],
  capabilities: ["production.approve"],
});

type FakeCheck = QcCheckRecord;
type FakeReview = QcReviewRecord;
type FakeDecision = QcReviewDecisionRecord;
type FakeResult = QcResultRecord;
type FakeIssue = QcIssueRecord;

interface FakeState {
  checks: FakeCheck[];
  reviews: FakeReview[];
  decisions: FakeDecision[];
  results: FakeResult[];
  issues: FakeIssue[];
  auditShouldFail: boolean;
  auditLog: Parameters<QcAuditAppend>[0][];
  /** When true, the transaction scope executes but the commit is simulated to fail. */
  failCommit: boolean;
}

const state = (): FakeState => ({
  checks: [],
  reviews: [],
  decisions: [],
  results: [],
  issues: [],
  auditShouldFail: false,
  auditLog: [],
  failCommit: false,
});

const mutationsFor = (s: FakeState, inTx: boolean): QcTransaction => ({
  insertCheck: async (input) => {
    const row: FakeCheck = {
      id: id("chk"),
      orgId: input.orgId,
      name: input.name,
      appliesToKind: input.appliesToKind,
      checkType: input.checkType,
      parameters: input.parameters,
      required: input.required,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    s.checks.push(row);
    return row;
  },
  updateCheck: async (checkId, patch) => {
    const row = s.checks.find((c) => c.id === checkId);
    if (!row) throw new Error("no check");
    const next = {
      ...row,
      ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {}),
      ...(patch.required !== undefined ? { required: patch.required } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: new Date().toISOString(),
    };
    Object.assign(row, next);
    return row;
  },
  insertReview: async (input) => {
    const row: FakeReview = {
      id: id("rev"),
      orgId: input.orgId,
      subjectKind: input.subjectKind,
      subjectRef: input.subjectRef,
      status: "pending",
      requestedBy: input.requestedBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    s.reviews.push(row);
    return row;
  },
  updateReviewStatus: async (reviewId, status) => {
    const idx = s.reviews.findIndex((r) => r.id === reviewId);
    if (idx < 0) throw new Error("no review");
    const next: FakeReview = {
      ...s.reviews[idx]!,
      status,
      updatedAt: new Date().toISOString(),
    };
    s.reviews[idx] = next;
    return next;
  },
  insertDecision: async (input) => {
    const row: FakeDecision = {
      id: id("dec"),
      orgId: input.orgId,
      reviewId: input.reviewId,
      decision: input.decision,
      reviewerOperatorId: input.reviewerOperatorId,
      reason: input.reason,
      capabilityUsed: input.capabilityUsed,
      createdAt: new Date().toISOString(),
    };
    s.decisions.push(row);
    return row;
  },
  insertResult: async (input) => {
    const row: FakeResult = {
      id: id("res"),
      orgId: input.orgId,
      reviewId: input.reviewId,
      checkId: input.checkId,
      outcome: input.outcome,
      evaluatedBy: input.evaluatedBy,
      ruleRef: input.ruleRef,
      details: input.details,
      evaluatedAt: new Date().toISOString(),
    };
    s.results.push(row);
    return row;
  },
  resolveIssue: async (issueId, input) => {
    const idx = s.issues.findIndex((i) => i.id === issueId);
    if (idx < 0) throw new Error("no issue");
    const next: FakeIssue = {
      ...s.issues[idx]!,
      resolution: input.resolution,
      resolvedBy: input.resolvedBy,
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    s.issues[idx] = next;
    return next;
  },
  appendAudit: async (entry) => {
    if (s.auditShouldFail) throw new Error("audit write failed");
    s.auditLog.push(entry);
    if (inTx && s.failCommit) throw new Error("simulated commit failure");
  },
});

const fakeRepository = (s: FakeState): QcRepository => ({
  findCheckById: async (orgId, checkId) => s.checks.find((c) => c.orgId === orgId && c.id === checkId) ?? null,
  findCheckByName: async (orgId, name) => s.checks.find((c) => c.orgId === orgId && c.name === name) ?? null,
  listChecksByOrg: async (orgId) => s.checks.filter((c) => c.orgId === orgId),
  findReviewById: async (rid) => s.reviews.find((r) => r.id === rid) ?? null,
  findReviewBySubject: async (orgId, kind, ref) =>
    s.reviews.find((r) => r.orgId === orgId && r.subjectKind === kind && r.subjectRef === ref) ?? null,
  listReviewsByOrg: async (orgId) => s.reviews.filter((r) => r.orgId === orgId),
  findDecisionById: async (did) => s.decisions.find((d) => d.id === did) ?? null,
  listDecisionsByReviewId: async (rid) => s.decisions.filter((d) => d.reviewId === rid),
  listResultsByReviewId: async (rid) =>
    s.results
      .filter((r) => r.reviewId === rid)
      .sort((a, b) =>
        a.evaluatedAt === b.evaluatedAt ? (a.id < b.id ? 1 : -1) : a.evaluatedAt < b.evaluatedAt ? 1 : -1,
      ),
  findIssueById: async (iid) => s.issues.find((i) => i.id === iid) ?? null,
  listIssuesByResultIds: async (rids) => s.issues.filter((i) => rids.includes(i.resultId)),

  insertCheck: (input) => mutationsFor(s, false).insertCheck(input),
  updateCheck: (checkId, patch) => mutationsFor(s, false).updateCheck(checkId, patch),
  insertReview: (input) => mutationsFor(s, false).insertReview(input),
  updateReviewStatus: (reviewId, status) => mutationsFor(s, false).updateReviewStatus(reviewId, status),
  insertDecision: (input) => mutationsFor(s, false).insertDecision(input),
  insertResult: (input) => mutationsFor(s, false).insertResult(input),
  resolveIssue: (issueId, input) => mutationsFor(s, false).resolveIssue(issueId, input),

  /**
   * Snapshot/restore transaction: an exception inside `work` (e.g. a failing
   * audit append simulating a commit failure) restores ALL state — the D2.4-1
   * atomicity contract exercised exactly as the production Drizzle adapter.
   */
  runInTransaction: async <T>(work: (tx: QcTransaction) => Promise<T>): Promise<T> => {
    const snapshot = JSON.stringify(s);
    try {
      return await work(mutationsFor(s, true));
    } catch (e) {
      const restored = JSON.parse(snapshot) as FakeState;
      s.checks = restored.checks;
      s.reviews = restored.reviews;
      s.decisions = restored.decisions;
      s.results = restored.results;
      s.issues = restored.issues;
      s.auditLog = restored.auditLog;
      throw e;
    }
  },
});

/** Subject port: only subj-asset/gen/prod exist in org-1; publication unsupported. */
const subjectPort = (): QcResolvedSubjectPort => async (orgId, kind, ref) => {
  if (orgId !== "org-1") return null;
  if (kind === "asset_version" && ref === "11111111-1111-4111-8111-111111111111") {
    return {
      kind: "asset_version",
      assetVersion: {
        id: ref,
        orgId,
        assetId: "asset-1",
        versionNumber: 1,
        bucket: "b",
        storageKey: "k",
        checksum: "sha",
        byteSize: 10,
        mimeType: "image/png",
        technicalMetadata: {},
      },
    };
  }
  if (kind === "generation" && ref === "22222222-2222-4222-8222-222222222222") {
    return { kind: "generation", generation: { id: ref, orgId, status: "completed" } };
  }
  if (kind === "production" && ref === "33333333-3333-4333-8333-333333333333") {
    return { kind: "production", production: { id: ref, orgId, status: "planned" } };
  }
  if (kind === "publication") {
    return { kind: "publication", unsupported: true };
  }
  return null;
};

const makeService = (
  s: FakeState = state(),
  publisher?: EventPublisher,
  overrides: Partial<Parameters<typeof createQcService>[0]> = {},
): { svc: QcService; s: FakeState } => ({
  svc: createQcService({
    repository: fakeRepository(s),
    resolveSubject: subjectPort(),
    ...(publisher ? { publisher } : {}),
    eventIdFactory: () => `evt-${String(++seq)}`,
    ...overrides,
  }),
  s,
});

const errOf = <T>(r: QcCommandResult<T>): { reason: string; message: string } => {
  if (r.ok) throw new Error("expected error");
  return r.error;
};

const valOf = <T>(r: QcCommandResult<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

/** Capture emitted events via a recording publisher. */
const recordingPublisher = (): { publisher: EventPublisher; events: { name: string; payload: unknown }[] } => {
  const events: { name: string; payload: unknown }[] = [];
  const publisher = {
    async publish(event: { name: string; payload: Record<string, unknown> }) {
      events.push({ name: event.name, payload: event.payload });
    },
  } as unknown as EventPublisher;
  return { publisher, events };
};

describe("qc checks (D2.11-1, D2.11-7)", () => {
  it("registers a check and audits in the same transaction", async () => {
    const { svc, s } = makeService();
    const check = valOf(
      await svc.registerQcCheck(actor(), {
        name: "checksum-present",
        appliesToKind: "asset_version",
        checkType: "technical",
      }),
    );
    expect(check.required).toBe(true);
    expect(check.status).toBe("active");
    expect(s.auditLog.map((a) => a.action)).toContain("qc.qc_check_registered");
  });

  it("rejects duplicate check names deterministically", async () => {
    const { svc } = makeService();
    await svc.registerQcCheck(actor(), { name: "c1", appliesToKind: "asset_version", checkType: "technical" });
    const e = errOf(
      await svc.registerQcCheck(actor(), { name: "c1", appliesToKind: "generation", checkType: "rights" }),
    );
    expect(e.reason).toBe("invalid_request");
  });

  it("archives a check; archived checks cannot attach new results", async () => {
    const { svc, s } = makeService();
    const check = valOf(
      await svc.registerQcCheck(actor(), { name: "c", appliesToKind: "asset_version", checkType: "technical" }),
    );
    await svc.updateQcCheck(actor(), check.id, { status: "archived" });
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    await svc.submitForReview(actor(), review.id);
    const e = errOf(await svc.recordResult(actor(), review.id, { checkId: check.id, outcome: "pass", evaluatedBy: "human" }));
    expect(e.reason).toBe("check_archived");
    expect(s.auditLog.map((a) => a.action)).toContain("qc.qc_check_updated");
  });

  it("missing capability fails closed (D2.11-8)", async () => {
    const { svc } = makeService();
    const e = errOf(
      await svc.registerQcCheck(actor({ capabilities: ["audit.read"] }), {
        name: "c",
        appliesToKind: "asset_version",
        checkType: "technical",
      }),
    );
    expect(e.reason).toBe("missing_capability");
  });
});

describe("review lifecycle (DM section 32.5)", () => {
  it("requestReview creates a pending review, audits, and emits qc.requested post-commit", async () => {
    const { publisher, events } = recordingPublisher();
    const { svc, s } = makeService(state(), publisher);
    const out = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(out.review.status).toBe("pending");
    expect(out.deduplicated).toBe(false);
    expect(s.auditLog.map((a) => a.action)).toContain("qc.qc_review_requested");
    expect(events.map((e) => e.name)).toEqual(["qc.requested"]);
  });

  it("duplicate requestReview deduplicates to the existing review with no second event", async () => {
    const { publisher, events } = recordingPublisher();
    const { svc } = makeService(state(), publisher);
    const input = {
      subjectKind: "asset_version" as const,
      subjectRef: "11111111-1111-4111-8111-111111111111",
    };
    await svc.requestReview(actor(), input);
    const out = valOf(await svc.requestReview(actor(), input));
    expect(out.deduplicated).toBe(true);
    expect(events.map((e) => e.name)).toEqual(["qc.requested"]);
  });

  it("cross-org subject resolution is IDOR-safe (subject_not_found)", async () => {
    const { svc } = makeService();
    const e = errOf(
      await svc.requestReview(otherActor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(e.reason).toBe("subject_not_found");
  });

  it("publication subjects FAIL CLOSED (D2.11-2)", async () => {
    const { svc } = makeService();
    const e = errOf(
      await svc.requestReview(actor(), {
        subjectKind: "publication",
        subjectRef: "44444444-4444-4444-8444-444444444444",
      }),
    );
    expect(e.reason).toBe("subject_unsupported");
  });

  it("full happy path: pending → in_review → approved, with immutable decision + qc.approved", async () => {
    const { publisher, events } = recordingPublisher();
    const { svc, s } = makeService(state(), publisher);
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "generation",
        subjectRef: "22222222-2222-4222-8222-222222222222",
      }),
    ).review;
    await svc.submitForReview(actor(), review.id);
    const { review: updated, decision } = valOf(
      await svc.recordDecision(actor(), review.id, { decision: "approve" }),
    );
    expect(updated.status).toBe("approved");
    expect(decision.reviewerOperatorId).toBe("op-1");
    expect(decision.capabilityUsed).toBe("production.approve");
    expect(events.map((e) => e.name)).toEqual(["qc.requested", "qc.approved"]);
    expect(s.auditLog.map((a) => a.action)).toContain("qc.qc_decision_recorded");
  });

  it("reject requires a reason and emits qc.rejected with it", async () => {
    const { publisher, events } = recordingPublisher();
    const { svc } = makeService(state(), publisher);
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "production",
        subjectRef: "33333333-3333-4333-8333-333333333333",
      }),
    ).review;
    await svc.submitForReview(actor(), review.id);
    const noReason = errOf(await svc.recordDecision(actor(), review.id, { decision: "reject" }));
    expect(noReason.reason).toBe("invalid_request");
    const { review: updated } = valOf(
      await svc.recordDecision(actor(), review.id, { decision: "reject", reason: "unacceptable" }),
    );
    expect(updated.status).toBe("rejected");
    const rejected = events.find((e) => e.name === "qc.rejected");
    expect((rejected?.payload as { reason: string }).reason).toBe("unacceptable");
  });

  it("changes_requested emits NO event; the reset edge returns it to pending (DM 32.5)", async () => {
    const { publisher, events } = recordingPublisher();
    const { svc } = makeService(state(), publisher);
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    await svc.submitForReview(actor(), review.id);
    const { review: cr } = valOf(
      await svc.recordDecision(actor(), review.id, { decision: "changes_requested", reason: "fix it" }),
    );
    expect(cr.status).toBe("changes_requested");
    expect(events.map((e) => e.name)).toEqual(["qc.requested"]);
    // changes_requested → pending is a legal edge; the review can then resubmit.
    const reset = valOf(await svc.resetChangesRequested(actor(), cr.id));
    expect(reset.status).toBe("pending");
    await svc.submitForReview(actor(), cr.id);
    const { review: approved } = valOf(await svc.recordDecision(actor(), cr.id, { decision: "approve" }));
    expect(approved.status).toBe("approved");
  });

  it("terminal states have no outgoing edges; duplicate decisions conflict", async () => {
    const { svc } = makeService();
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    await svc.submitForReview(actor(), review.id);
    await svc.recordDecision(actor(), review.id, { decision: "approve" });
    const dup = errOf(await svc.recordDecision(actor(), review.id, { decision: "reject", reason: "x" }));
    expect(dup.reason).toBe("decision_conflict");
    const again = errOf(await svc.submitForReview(actor(), review.id));
    expect(again.reason).toBe("invalid_transition");
  });

  it("transition map has terminal states with zero outgoing edges", () => {
    for (const t of TERMINAL_QC_REVIEW_STATUSES) expect(QC_REVIEW_TRANSITIONS[t]).toEqual([]);
    expect(QC_REVIEW_TRANSITIONS.pending).toEqual(["in_review"]);
    expect(QC_REVIEW_TRANSITIONS.in_review).toEqual(["approved", "rejected", "changes_requested"]);
    expect(QC_REVIEW_TRANSITIONS.changes_requested).toEqual(["pending"]);
  });

  it("cross-org review access is IDOR-safe for submit/decision/read", async () => {
    const { svc } = makeService();
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    expect(errOf(await svc.submitForReview(otherActor(), review.id)).reason).toBe("review_not_found");
    expect(
      errOf(await svc.recordDecision(otherActor(), review.id, { decision: "approve" })).reason,
    ).toBe("review_not_found");
    expect(errOf(await svc.getReview(otherActor(), review.id)).reason).toBe("review_not_found");
  });
});

describe("results & issues", () => {
  it("records results append-only; automated results require ruleRef provenance", async () => {
    const { svc } = makeService();
    const check = valOf(
      await svc.registerQcCheck(actor(), { name: "c", appliesToKind: "asset_version", checkType: "technical" }),
    );
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    const noRef = errOf(await svc.recordResult(actor(), review.id, { checkId: check.id, outcome: "pass", evaluatedBy: "automated" }));
    expect(noRef.reason).toBe("invalid_request");
    const r1 = valOf(
      await svc.recordResult(actor(), review.id, {
        checkId: check.id,
        outcome: "pass",
        evaluatedBy: "automated",
        ruleRef: "rule/v1",
      }),
    );
    const r2 = valOf(
      await svc.recordResult(actor(), review.id, {
        checkId: check.id,
        outcome: "fail",
        evaluatedBy: "human",
      }),
    );
    const got = valOf(await svc.getReview(actor(), review.id));
    expect(got.results).toHaveLength(2);
    expect(got.results[0]!.id).toBe(r2.id); // latest first
    expect(latestResultForCheck([r1, r2], check.id)!.id).toBe(r2.id);
  });

  it("check-kind mismatch and cross-org check fail closed", async () => {
    const { svc } = makeService();
    const check = valOf(
      await svc.registerQcCheck(actor(), { name: "c", appliesToKind: "generation", checkType: "technical" }),
    );
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    expect(
      errOf(await svc.recordResult(actor(), review.id, { checkId: check.id, outcome: "pass", evaluatedBy: "human" }))
        .reason,
    ).toBe("invalid_request");
    expect(
      errOf(
        await svc.recordResult(otherActor(), review.id, { checkId: check.id, outcome: "pass", evaluatedBy: "human" }),
      ).reason,
    ).toBe("review_not_found");
  });

  it("results cannot be recorded on terminal reviews", async () => {
    const { svc } = makeService();
    const check = valOf(
      await svc.registerQcCheck(actor(), { name: "c", appliesToKind: "asset_version", checkType: "technical" }),
    );
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    await svc.submitForReview(actor(), review.id);
    await svc.recordDecision(actor(), review.id, { decision: "approve" });
    expect(
      errOf(await svc.recordResult(actor(), review.id, { checkId: check.id, outcome: "pass", evaluatedBy: "human" }))
        .reason,
    ).toBe("invalid_transition");
  });

  it("resolves an issue once; re-resolution conflicts deterministically", async () => {
    const { svc, s } = makeService();
    const issue: FakeIssue = {
      id: id("iss"),
      orgId: "org-1",
      resultId: "00000000-0000-4000-8000-000000000000",
      severity: "blocker",
      description: "bad",
      resolution: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    s.issues.push(issue);
    const resolved = valOf(await svc.resolveIssue(actor(), issue.id, { resolution: "resolved" }));
    expect(resolved.resolution).toBe("resolved");
    expect(resolved.resolvedBy).toBe("op-1");
    expect(errOf(await svc.resolveIssue(actor(), issue.id, { resolution: "waived" })).reason).toBe(
      "resolution_conflict",
    );
    expect(s.auditLog.map((a) => a.action)).toContain("qc.qc_issue_resolved");
  });
});

describe("audit integrity (D2.4-1, D2.10-4)", () => {
  it("a failing audit rolls back the domain mutation (same transaction)", async () => {
    const { svc, s } = makeService();
    s.auditShouldFail = true;
    await expect(
      svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow();
    expect(s.reviews).toHaveLength(0);
    expect(s.auditLog).toHaveLength(0);
  });

  it("repositories without transactions fail closed in production composition", async () => {
    const s = state();
    const repo = fakeRepository(s) as QcRepository;
    const noTxRepo: QcRepository = { ...repo };
    delete (noTxRepo as { runInTransaction?: unknown }).runInTransaction;
    const svc = createQcService({
      repository: noTxRepo,
      resolveSubject: subjectPort(),
      eventIdFactory: () => "evt-x",
    });
    await expect(
      svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow(/D2\.4-1 violation/);
    expect(s.reviews).toHaveLength(0);
  });

  it("recordResult with a service actor (no operator) skips audit WITHOUT fabricating identity", async () => {
    const { svc, s } = makeService();
    const check = valOf(
      await svc.registerQcCheck(actor(), { name: "c", appliesToKind: "asset_version", checkType: "technical" }),
    );
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    const before = s.auditLog.length;
    const result = valOf(
      await svc.recordResult(serviceActor(), review.id, {
        checkId: check.id,
        outcome: "pass",
        evaluatedBy: "automated",
        ruleRef: "rule/v1",
      }),
    );
    expect(result.evaluatedBy).toBe("automated");
    expect(s.auditLog.length).toBe(before);
    expect(s.auditLog.some((a) => a.actorId === "system" && a.action === "qc.qc_result_recorded")).toBe(false);
  });
});

describe("events (D2.11-4)", () => {
  it("only the three documented event names are ever emitted", async () => {
    const { publisher, events } = recordingPublisher();
    const { svc } = makeService(state(), publisher);
    const review = valOf(
      await svc.requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      }),
    ).review;
    await svc.submitForReview(actor(), review.id);
    await svc.recordDecision(actor(), review.id, { decision: "approve" });
    await svc.resetChangesRequested.call({} as never, actor(), review.id).catch(() => undefined);
    expect(events.map((e) => e.name).sort()).toEqual(["qc.approved", "qc.requested"].sort());
    for (const e of events) {
      expect(["qc.requested", "qc.approved", "qc.rejected"]).toContain(e.name);
    }
  });

  it("a failed transaction emits no event (audit failure rolls everything back)", async () => {
    const { publisher, events } = recordingPublisher();
    const { svc, s } = makeService(state(), publisher);
    s.auditShouldFail = true;
    await svc
      .requestReview(actor(), {
        subjectKind: "asset_version",
        subjectRef: "11111111-1111-4111-8111-111111111111",
      })
      .catch(() => undefined);
    expect(events).toHaveLength(0);
  });
});

describe("publication eligibility (D2.11-6)", () => {
  const review = (status: QcReviewRecord["status"]): Pick<QcReviewRecord, "status" | "subjectKind"> => ({
    status,
    subjectKind: "asset_version",
  });
  const check = (overrides: Partial<QcCheckRecord> = {}): QcCheckRecord => ({
    id: "chk-1",
    orgId: "org-1",
    name: "c",
    appliesToKind: "asset_version",
    checkType: "technical",
    parameters: {},
    required: true,
    status: "active",
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  });
  const result = (overrides: Partial<QcResultRecord> = {}): QcResultRecord => ({
    id: "res-1",
    orgId: "org-1",
    reviewId: "rev-1",
    checkId: "chk-1",
    outcome: "pass",
    evaluatedBy: "human",
    ruleRef: null,
    details: {},
    evaluatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
  const issue = (overrides: Partial<QcIssueRecord> = {}): QcIssueRecord => ({
    id: "iss-1",
    orgId: "org-1",
    resultId: "res-1",
    severity: "blocker",
    description: "d",
    resolution: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  });

  it("eligible only when review approved + all required latest results pass + no open blockers", () => {
    const c = check();
    const r = result();
    expect(
      evaluatePublicationEligibility(review("approved"), [r], [], [c]).eligible,
    ).toBe(true);
    expect(evaluatePublicationEligibility(review("in_review"), [r], [], [c]).eligible).toBe(false);
    expect(evaluatePublicationEligibility(review("approved"), [{ ...r, outcome: "warn" }], [], [c]).eligible).toBe(
      false,
    );
    expect(
      evaluatePublicationEligibility(review("approved"), [r], [issue()], [c]).eligible,
    ).toBe(false);
    expect(
      evaluatePublicationEligibility(review("approved"), [r], [{ ...issue(), resolution: "resolved" }], [c]).eligible,
    ).toBe(true);
    expect(evaluatePublicationEligibility(review("approved"), [], [], [c]).eligible).toBe(false);
    expect(evaluatePublicationEligibility(review("approved"), [], [], []).eligible).toBe(true);
  });

  it("archived or non-applicable required checks are excluded from gating; latest result wins", () => {
    const archived = check({ id: "chk-a", status: "archived" });
    const otherKind = check({ id: "chk-k", appliesToKind: "generation" });
    const optional = check({ id: "chk-o", required: false });
    const active = check();
    const older = result({ id: "res-old", outcome: "fail", evaluatedAt: "2025-01-01T00:00:00Z" });
    const newer = result({ outcome: "pass", evaluatedAt: "2026-01-01T00:00:00Z" });
    const verdict = evaluatePublicationEligibility(
      review("approved"),
      [older, newer],
      [],
      [archived, otherKind, optional, active],
    );
    expect(verdict.eligible).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("uncertainty fails closed with reasons", () => {
    const verdict = evaluatePublicationEligibility(review("changes_requested"), [], [], [check()]);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });
});
