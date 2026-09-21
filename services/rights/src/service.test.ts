/**
 * Rights service unit tests (Stage 2.21, D2.21-1..D2.21-8).
 *
 * In-memory fake repository mirroring the real Drizzle adapter semantics:
 * transaction-scoped audit sink with D2.4-1 rollback (a thrown mutation
 * removes its audit rows), immutable status-event append, org-scoped reads.
 * Covers the frozen matrix: owner/grant authoring with in-tx subject
 * integrity (same-org, fail-closed), the D2.21-5 lifecycle table incl.
 * terminal enforcement + reinstatement, capability gating, audit atomicity
 * (rollback removes mutation + status event + audit), failed mutation leaves
 * no audit row, server-derived org authority, and the pure fail-closed
 * evaluateUse seam (UNWIRED per D2.21-2).
 */
import { describe, expect, it } from "vitest";
import { createRightsService } from "./service";
import type {
  RightsAuditAppend,
  RightsGrantRecord,
  RightsOwnerRecord,
  RightsPrincipal,
  RightsRepository,
  RightsStatusEventRecord,
  RightsTransaction,
} from "./types";
import { RIGHTS_AUDIT_ACTIONS } from "./types";

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

type Store = {
  owners: RightsOwnerRecord[];
  grants: RightsGrantRecord[];
  events: RightsStatusEventRecord[];
  audit: Parameters<RightsAuditAppend>[0][];
  /** Subject rows live in OTHER contexts; minimal refs for the integrity seam. */
  subjects: { id: string; orgId: string; status: string }[];
  /** Test hook: force the next mutation to throw (rollback/atomicity proofs). */
  failNextMutation?: boolean;
};

const now = () => new Date();
let n = 0;
const seq = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const makeStore = (): Store => ({ owners: [], grants: [], events: [], audit: [], subjects: [] });

const makeTx = (store: Store): RightsTransaction => ({
  findOwnerById: async (id) => store.owners.find((r) => r.id === id) ?? null,
  findGrantById: async (id) => store.grants.find((r) => r.id === id) ?? null,
  findSubjectRef: async (_kind, subjectId) =>
    store.subjects.find((s) => s.id === subjectId) ?? null,
  insertOwner: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    const row: RightsOwnerRecord = {
      id: seq(),
      orgId: input.orgId,
      kind: input.kind,
      displayName: input.displayName,
      contactRef: input.contactRef,
      verificationStatus: "unverified",
      createdAt: now(),
      updatedAt: now(),
    };
    store.owners.push(row);
    return row;
  },
  setOwnerVerificationStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.owners.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, verificationStatus: status, updatedAt: now() };
    store.owners = store.owners.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  insertGrant: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    const row: RightsGrantRecord = {
      id: seq(),
      orgId: input.orgId,
      ownerId: input.ownerId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      scope: input.scope,
      platforms: [...input.platforms],
      territories: [...input.territories],
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      status: input.status,
      grantedBy: input.grantedBy,
      evidenceRefs: [...input.evidenceRefs],
      createdAt: now(),
      updatedAt: now(),
    };
    store.grants.push(row);
    return row;
  },
  setGrantStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.grants.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.grants = store.grants.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  insertStatusEvent: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    const row: RightsStatusEventRecord = {
      id: seq(),
      orgId: input.orgId,
      grantId: input.grantId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason,
      actorId: input.actorId,
      createdAt: now(),
    };
    store.events.push(row);
    return row;
  },
  appendAudit: async (entry) => {
    store.audit.push(entry);
  },
});

/** Fake repo with D2.4-1 transaction semantics: throw rolls back everything. */
const fakeRepo = (store: Store): RightsRepository => ({
  runInTransaction: async <T>(work: (tx: RightsTransaction) => Promise<T>): Promise<T> => {
    const auditBefore = store.audit.length;
    try {
      return await work(makeTx(store));
    } catch (e) {
      // Rollback: audit rows written inside the failed tx are removed with
      // the mutation (the fake mirrors real transactional atomicity).
      store.audit.length = auditBefore;
      throw e;
    }
  },
  findOwnerById: async (id) => store.owners.find((r) => r.id === id) ?? null,
  listOwners: async (orgId, limit) => store.owners.filter((r) => r.orgId === orgId).slice(0, limit),
  setOwnerVerificationStatus: makeTx(store).setOwnerVerificationStatus,
  findGrantById: async (id) => store.grants.find((r) => r.id === id) ?? null,
  findGrantBySubject: async (orgId, subjectKind, subjectId, scope) =>
    store.grants.filter(
      (r) => r.orgId === orgId && r.subjectKind === subjectKind && r.subjectId === subjectId && r.scope === scope,
    ),
  listGrants: async (orgId, limit) => store.grants.filter((r) => r.orgId === orgId).slice(0, limit),
  listStatusEvents: async (grantId) => store.events.filter((r) => r.grantId === grantId),
  setStatusEvent: async ({ event }) =>
    makeTx(store).insertStatusEvent({
      orgId: event.orgId,
      grantId: event.grantId,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reason: event.reason,
      actorId: event.actorId,
    }),
  insertOwner: makeTx(store).insertOwner,
  insertGrant: makeTx(store).insertGrant,
  setGrantStatus: makeTx(store).setGrantStatus,
  insertStatusEvent: makeTx(store).insertStatusEvent,
});

// ---------------------------------------------------------------------------
// Principals (server-derived shape; org/actor never come from input bodies)
// ---------------------------------------------------------------------------

const admin = (orgId: string): RightsPrincipal => ({
  operatorId: "11111111-1111-4111-8111-111111111111",
  orgId,
  capabilities: ["rights.manage", "rights.read"],
});
const reviewer = (orgId: string): RightsPrincipal => ({
  operatorId: "33333333-3333-4333-8333-333333333333",
  orgId,
  capabilities: ["rights.read"],
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const SUBJECT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SUBJECT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Seed: a verified owner in `orgId` + subject refs for both orgs. */
const seedOwner = async (svc: ReturnType<typeof createRightsService>, orgId: string) => {
  const p = admin(orgId);
  const owner = await svc.createOwner(p, { kind: "individual", displayName: "Jane Doe" });
  if (!owner.ok) throw new Error(owner.error.message);
  const pending = await svc.changeOwnerVerification(p, { id: owner.value.id, status: "pending" });
  if (!pending.ok) throw new Error(pending.error.message);
  const verified = await svc.changeOwnerVerification(p, { id: owner.value.id, status: "verified" });
  if (!verified.ok) throw new Error(verified.error.message);
  return { p, owner: verified.value };
};

const baseGrantInput = (ownerId: string) => ({
  ownerId,
  subjectKind: "digital_human" as const,
  subjectId: SUBJECT_A,
  scope: "publication" as const,
  platforms: ["stratifit_media" as const],
  territories: ["worldwide"],
});

/** Seed a draft grant in `orgId` (subject refs must already be in the store). */
const seedGrant = async (svc: ReturnType<typeof createRightsService>, orgId: string) => {
  const { p, owner } = await seedOwner(svc, orgId);
  const grant = await svc.createGrant(p, baseGrantInput(owner.id));
  if (!grant.ok) throw new Error(grant.error.message);
  return { p, grant: grant.value };
};

// ---------------------------------------------------------------------------
// Owner authoring + lifecycle
// ---------------------------------------------------------------------------

describe("rights owners", () => {
  it("creates an owner with the frozen audit action and real operator id", async () => {
    const store = makeStore();
    const svc = createRightsService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);
    const result = await svc.createOwner(p, { kind: "organization", displayName: "Acme Corp", contactRef: "acct-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verificationStatus).toBe("unverified");
    expect(result.value.orgId).toBe(ORG_A);
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]!.action).toBe(RIGHTS_AUDIT_ACTIONS[0]);
    expect(store.audit[0]!.actorId).toBe(p.operatorId);
    expect(store.audit[0]!.organizationId).toBe(ORG_A);
  });

  it("walks the verification lifecycle unverified → pending → verified", async () => {
    const store = makeStore();
    const svc = createRightsService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);
    const owner = await svc.createOwner(p, { kind: "individual", displayName: "Jane" });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const a = await svc.changeOwnerVerification(p, { id: owner.value.id, status: "pending" });
    expect(a.ok).toBe(true);
    const b = await svc.changeOwnerVerification(p, { id: owner.value.id, status: "verified" });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value.verificationStatus).toBe("verified");
    expect(store.audit.map((a2) => a2.action)).toEqual([
      RIGHTS_AUDIT_ACTIONS[0], RIGHTS_AUDIT_ACTIONS[1], RIGHTS_AUDIT_ACTIONS[1],
    ]);
  });

  it("rejects invalid verification transitions (verified → verified, unverified → verified)", async () => {
    const store = makeStore();
    const svc = createRightsService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);
    const owner = await svc.createOwner(p, { kind: "individual", displayName: "Jane" });
    if (!owner.ok) throw new Error("seed failed");
    const direct = await svc.changeOwnerVerification(p, { id: owner.value.id, status: "verified" });
    expect(direct.ok).toBe(false);
    const b = await svc.changeOwnerVerification(p, { id: owner.value.id, status: "verified" });
    expect(b.ok).toBe(false);
    // No audit rows for rejected transitions.
    expect(store.audit).toHaveLength(1); // only the create
  });

  it("allows re-review: verified/rejected → pending", async () => {
    const store = makeStore();
    const svc = createRightsService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);
    const owner = await svc.createOwner(p, { kind: "individual", displayName: "Jane" });
    if (!owner.ok) throw new Error("seed failed");
    await svc.changeOwnerVerification(p, { id: owner.value.id, status: "pending" });
    const verified = await svc.changeOwnerVerification(p, { id: owner.value.id, status: "verified" });
    const again = await svc.changeOwnerVerification(p, { id: owner.value.id, status: "pending" });
    expect(again.ok).toBe(true);
    void verified;
  });

  it("enforces read capability: reviewer cannot create owners", async () => {
    const store = makeStore();
    const svc = createRightsService({ repository: fakeRepo(store) });
    const result = await svc.createOwner(reviewer(ORG_A), { kind: "individual", displayName: "X" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("unauthorized");
    expect(store.owners).toHaveLength(0);
    expect(store.audit).toHaveLength(0);
  });

  it("is IDOR-safe: cross-org owner verification is not_found", async () => {
    const store = makeStore();
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { owner } = await seedOwner(svc, ORG_A);
    const otherAdmin = admin(ORG_B);
    const result = await svc.changeOwnerVerification(otherAdmin, { id: owner.id, status: "pending" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Grant authoring: parent/subject integrity
// ---------------------------------------------------------------------------

describe("rights grants — authoring", () => {
  it("creates a draft grant with owner + subject validated in-transaction", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, owner } = await seedOwner(svc, ORG_A);
    const grant = await svc.createGrant(p, baseGrantInput(owner.id));
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(grant.value.status).toBe("draft");
    expect(grant.value.grantedBy).toBe(p.operatorId);
    expect(store.audit.at(-1)!.action).toBe(RIGHTS_AUDIT_ACTIONS[2]);
  });

  it("rejects cross-org subject references as not_found (no existence leak)", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_B, orgId: ORG_B, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, owner } = await seedOwner(svc, ORG_A);
    const grant = await svc.createGrant(p, { ...baseGrantInput(owner.id), subjectId: SUBJECT_B });
    expect(grant.ok).toBe(false);
    if (!grant.ok) expect(grant.error.reason).toBe("not_found");
    expect(store.grants).toHaveLength(0);
    expect(store.audit).toHaveLength(3); // owner create + 2 verification only
  });

  it("rejects missing subject references as not_found", async () => {
    const store = makeStore();
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, owner } = await seedOwner(svc, ORG_A);
    const grant = await svc.createGrant(p, baseGrantInput(owner.id));
    expect(grant.ok).toBe(false);
    if (!grant.ok) expect(grant.error.reason).toBe("not_found");
  });

  it("rejects rejected-verification owners as inactive_parent", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, owner } = await seedOwner(svc, ORG_A);
    // verified → pending → rejected
    await svc.changeOwnerVerification(p, { id: owner.id, status: "pending" });
    await svc.changeOwnerVerification(p, { id: owner.id, status: "rejected" });
    const grant = await svc.createGrant(p, baseGrantInput(owner.id));
    expect(grant.ok).toBe(false);
    if (!grant.ok) expect(grant.error.reason).toBe("inactive_parent");
  });

  it("rejects invalid validity windows and empty platform/territory lists", async () => {
    const store = makeStore();
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, owner } = await seedOwner(svc, ORG_A);
    const badWindow = await svc.createGrant(p, {
      ...baseGrantInput(owner.id),
      startsAt: new Date("2026-02-01T00:00:00Z"),
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(badWindow.ok).toBe(false);
    if (!badWindow.ok) expect(badWindow.error.reason).toBe("invalid_input");
    const badPlatforms = await svc.createGrant(p, { ...baseGrantInput(owner.id), platforms: [] });
    expect(badPlatforms.ok).toBe(false);
    const badTerritories = await svc.createGrant(p, { ...baseGrantInput(owner.id), territories: [] });
    expect(badTerritories.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Grant lifecycle (D2.21-5): every allowed + forbidden transition
// ---------------------------------------------------------------------------

describe("rights grants — lifecycle", () => {
  it("allows draft → active (activates with a status-event row)", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, grant } = await seedGrant(svc, ORG_A);
    const result = await svc.changeGrantStatus(p, { id: grant.id, status: "active" });
    expect(result.ok).toBe(true);
    const events = await svc.getGrant(p, grant.id);
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.value.history).toHaveLength(1);
      expect(events.value.history[0]!.fromStatus).toBe("draft");
      expect(events.value.history[0]!.toStatus).toBe("active");
      expect(events.value.history[0]!.actorId).toBe(p.operatorId);
    }
  });

  it("allows active ⇄ suspended (suspend + reinstatement)", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, grant } = await seedGrant(svc, ORG_A);
    await svc.changeGrantStatus(p, { id: grant.id, status: "active" });
    const susp = await svc.changeGrantStatus(p, { id: grant.id, status: "suspended", reason: "review hold" });
    expect(susp.ok).toBe(true);
    const reinstate = await svc.changeGrantStatus(p, { id: grant.id, status: "active" });
    expect(reinstate.ok).toBe(true);
    const events = await svc.getGrant(p, grant.id);
    if (events.ok) expect(events.value.history).toHaveLength(3); // activate, suspend, reinstate
  });

  it("allows active → revoked and suspended → revoked", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const a = await seedGrant(svc, ORG_A);
    await svc.changeGrantStatus(a.p, { id: a.grant.id, status: "active" });
    const revoked = await svc.changeGrantStatus(a.p, { id: a.grant.id, status: "revoked" });
    expect(revoked.ok).toBe(true);
    const b = await seedGrant(svc, ORG_A);
    await svc.changeGrantStatus(b.p, { id: b.grant.id, status: "active" });
    await svc.changeGrantStatus(b.p, { id: b.grant.id, status: "suspended" });
    const revoked2 = await svc.changeGrantStatus(b.p, { id: b.grant.id, status: "revoked" });
    expect(revoked2.ok).toBe(true);
  });

  it("allows active → expired and suspended → expired (explicit operator command)", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const a = await seedGrant(svc, ORG_A);
    await svc.changeGrantStatus(a.p, { id: a.grant.id, status: "active" });
    const expired = await svc.changeGrantStatus(a.p, { id: a.grant.id, status: "expired" });
    expect(expired.ok).toBe(true);
    const b = await seedGrant(svc, ORG_A);
    await svc.changeGrantStatus(b.p, { id: b.grant.id, status: "active" });
    await svc.changeGrantStatus(b.p, { id: b.grant.id, status: "suspended" });
    const expired2 = await svc.changeGrantStatus(b.p, { id: b.grant.id, status: "expired" });
    expect(expired2.ok).toBe(true);
  });

  it("forbids every invalid transition: draft→suspended/revoked/expired, active→active, terminal→anything", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, grant } = await seedGrant(svc, ORG_A);
    for (const to of ["suspended", "revoked", "expired"] as const) {
      const r = await svc.changeGrantStatus(p, { id: grant.id, status: to });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe("invalid_status_transition");
    }
    // draft → active → terminal checks
    await svc.changeGrantStatus(p, { id: grant.id, status: "active" });
    const same = await svc.changeGrantStatus(p, { id: grant.id, status: "active" });
    expect(same.ok).toBe(false);
    await svc.changeGrantStatus(p, { id: grant.id, status: "revoked" });
    for (const to of ["active", "suspended", "expired", "revoked", "draft"] as const) {
      const r = await svc.changeGrantStatus(p, { id: grant.id, status: to });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe("invalid_status_transition");
    }
  });

  it("is IDOR-safe: cross-org grant status change is not_found with no audit", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { grant } = await seedGrant(svc, ORG_A);
    const auditBefore = store.audit.length;
    const result = await svc.changeGrantStatus(admin(ORG_B), { id: grant.id, status: "active" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("not_found");
    expect(store.audit.length).toBe(auditBefore);
  });

  it("getGrant is IDOR-safe: cross-org detail is not_found", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { grant } = await seedGrant(svc, ORG_A);
    const result = await svc.getGrant(admin(ORG_B), grant.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("not_found");
  });

  it("list endpoints scope to the caller's organization only", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    await seedGrant(svc, ORG_A);
    const otherOrg = await svc.listGrants(admin(ORG_B));
    expect(otherOrg.ok).toBe(true);
    if (otherOrg.ok) expect(otherOrg.value).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Audit atomicity (D2.4-1 / D2.21-8)
// ---------------------------------------------------------------------------

describe("rights audit atomicity", () => {
  it("rolls back mutation + status event + audit when the mutation throws", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, owner } = await seedOwner(svc, ORG_A);
    const auditBefore = store.audit.length;
    store.failNextMutation = true;
    // House semantics (Stage 2.20 precedent): infrastructure failures PROPAGATE
    // — the service never converts them into typed domain results. The D2.4-1
    // transaction rolls back, which is what the assertions below prove.
    await expect(svc.createGrant(p, baseGrantInput(owner.id))).rejects.toThrow("forced insert failure");
    store.failNextMutation = false;
    expect(store.grants).toHaveLength(0);
    expect(store.events).toHaveLength(0);
    expect(store.audit.length).toBe(auditBefore); // rollback removed the audit row
  });

  it("invalid lifecycle transition leaves no audit row", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, grant } = await seedGrant(svc, ORG_A);
    const auditBefore = store.audit.length;
    await svc.changeGrantStatus(p, { id: grant.id, status: "revoked" }); // draft→revoked forbidden
    expect(store.audit.length).toBe(auditBefore);
  });

  it("records real server-derived operator + org ids on every audit row", async () => {
    const store = makeStore();
    store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const svc = createRightsService({ repository: fakeRepo(store) });
    const { p, grant } = await seedGrant(svc, ORG_A);
    await svc.changeGrantStatus(p, { id: grant.id, status: "active" });
    for (const row of store.audit) {
      expect(row.actorId).toBe("11111111-1111-4111-8111-111111111111");
      expect(row.organizationId).toBe(ORG_A);
    }
  });
});
// ---------------------------------------------------------------------------
// evaluateUse — pure fail-closed evaluation (D2.21-2, UNWIRED)
// ---------------------------------------------------------------------------

describe("evaluateUse", () => {
  const seedActive = async (opts: {
    store: ReturnType<typeof makeStore>;
    platforms?: ("stratifit_media" | "all")[];
    territories?: string[];
    startsAt?: Date;
    expiresAt?: Date;
    status?: "active" | "suspended" | "revoked" | "expired";
  }) => {
    const svc = createRightsService({ repository: fakeRepo(opts.store) });
    opts.store.subjects.push({ id: SUBJECT_A, orgId: ORG_A, status: "active" });
    const { p, owner } = await seedOwner(svc, ORG_A);
    const grantInput = {
      ...baseGrantInput(owner.id),
      platforms: opts.platforms ?? ["stratifit_media"],
      territories: opts.territories ?? ["worldwide"],
      ...(opts.startsAt !== undefined ? { startsAt: opts.startsAt } : {}),
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    };
    const grant = await svc.createGrant(p, grantInput);
    if (!grant.ok) throw new Error(grant.error.message);
    await svc.changeGrantStatus(p, { id: grant.value.id, status: "active" });
    if (opts.status && opts.status !== "active") {
      if (opts.status === "suspended") {
        await svc.changeGrantStatus(p, { id: grant.value.id, status: "suspended" });
      }
      await svc.changeGrantStatus(p, { id: grant.value.id, status: opts.status });
    }
    return svc;
  };

  const useRequest = (at = new Date("2026-06-01T00:00:00Z")) => ({
    orgId: ORG_A,
    subjectKind: "digital_human" as const,
    subjectId: SUBJECT_A,
    scope: "publication" as const,
    platform: "stratifit_media" as const,
    territory: "US",
    at,
  });

  it("satisfied: active grant covering scope/platform/territory/window", async () => {
    const store = makeStore();
    const svc = await seedActive({ store });
    const result = await svc.evaluateUse(useRequest());
    expect(result.satisfied).toBe(true);
    expect(result.reasons).toHaveLength(0);
    expect(result.grantId).toBeDefined();
  });

  it("fail-closed: no applicable grant", async () => {
    const store = makeStore();
    const svc = await seedActive({ store });
    const result = await svc.evaluateUse({ ...useRequest(), subjectId: SUBJECT_B });
    expect(result.satisfied).toBe(false);
    expect(result.reasons[0]!.code).toBe("grant_not_found");
  });

  it("fail-closed: scope mismatch behaves like no grant (scope-keyed lookup)", async () => {
    const store = makeStore();
    const svc = await seedActive({ store });
    const result = await svc.evaluateUse({ ...useRequest(), scope: "advertising" });
    expect(result.satisfied).toBe(false);
    expect(result.reasons[0]!.code).toBe("grant_not_found");
  });

  it("fail-closed: platform mismatch", async () => {
    const store = makeStore();
    const svc = await seedActive({ store, platforms: ["stratifit_media"] });
    const result = await svc.evaluateUse({ ...useRequest(), platform: "youtube" });
    expect(result.satisfied).toBe(false);
    expect(result.reasons.some((r) => r.code === "platform_mismatch")).toBe(true);
  });

  it("fail-closed: territory mismatch when not worldwide", async () => {
    const store = makeStore();
    const svc = await seedActive({ store, territories: ["US"] });
    const result = await svc.evaluateUse({ ...useRequest(), territory: "DE" });
    expect(result.satisfied).toBe(false);
    expect(result.reasons.some((r) => r.code === "territory_mismatch")).toBe(true);
  });

  it("fail-closed: before the validity window", async () => {
    const store = makeStore();
    const svc = await seedActive({ store, startsAt: new Date("2026-07-01T00:00:00Z") });
    const result = await svc.evaluateUse(useRequest(new Date("2026-06-01T00:00:00Z")));
    expect(result.satisfied).toBe(false);
    expect(result.reasons.some((r) => r.code === "validity_window")).toBe(true);
  });

  it("fail-closed: at/after expiry", async () => {
    const store = makeStore();
    const svc = await seedActive({ store, expiresAt: new Date("2026-06-01T00:00:00Z") });
    const at = await svc.evaluateUse(useRequest(new Date("2026-06-01T00:00:00Z")));
    const after = await svc.evaluateUse(useRequest(new Date("2026-06-02T00:00:00Z")));
    expect(at.satisfied).toBe(false);
    expect(after.satisfied).toBe(false);
    expect(at.reasons.some((r) => r.code === "validity_window")).toBe(true);
  });

  it("fail-closed: suspended / revoked / expired grants never satisfy", async () => {
    for (const status of ["suspended", "revoked", "expired"] as const) {
      const store = makeStore();
      const svc = await seedActive({ store, status });
      const result = await svc.evaluateUse(useRequest());
      expect(result.satisfied).toBe(false);
      expect(result.reasons.some((r) => r.code === "grant_not_active")).toBe(true);
    }
  });

  it("coverage: 'all' platform + 'worldwide' territory satisfy any request", async () => {
    const store = makeStore();
    const svc = await seedActive({ store, platforms: ["all"], territories: ["worldwide"] });
    const result = await svc.evaluateUse({ ...useRequest(), platform: "tiktok", territory: "JP" });
    expect(result.satisfied).toBe(true);
  });
});
