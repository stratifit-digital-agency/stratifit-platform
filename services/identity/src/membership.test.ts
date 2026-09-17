import { describe, expect, it, vi } from "vitest";
import { InProcessEventPublisher } from "@stratifit/events";
import { createMembershipService, ROLE_RANK } from "./membership";
import type {
  MembershipActor,
  MembershipRecord,
  MembershipRepository,
  MembershipTransaction,
  TeamRecord,
} from "./types";

/**
 * Service-level security matrix (approved build order, items 9–11):
 * capability gating, cross-org denial, escalation guards, team assignment
 * semantics (D-3: no role on team rows), append-and-revoke history, events,
 * and the D4 audit seam (stub until admin-audit exists).
 */

const ORG = "org-1";

const membership = (over: Partial<MembershipRecord> = {}): MembershipRecord => ({
  id: "m-1",
  operatorId: "op-target",
  organizationId: ORG,
  teamId: null,
  role: "operator",
  status: "active",
  grantedBy: "op-admin",
  grantedAt: "2026-09-16T00:00:00.000Z",
  revokedAt: null,
  ...over,
});

const team = (over: Partial<TeamRecord> = {}): TeamRecord => ({
  id: "team-1",
  orgId: ORG,
  slug: "alpha",
  name: "Alpha",
  status: "active",
  ...over,
});

const actor = (
  over: Partial<MembershipActor> = { operatorId: "op-admin" },
): MembershipActor => ({
  operatorId: "op-admin",
  organizationId: ORG,
  roles: ["admin"],
  capabilities: ["admin.permissions", "audit.read", "production.approve"],
  ...over,
});

const repoMock = () => {
  const repo: MembershipRepository = {
    findOperatorById: vi.fn(async (id) =>
      id === "op-target" ? { id, orgId: ORG, status: "active" } : null,
    ),
    findOrganizationStatus: vi.fn(async () => "active"),
    findTeamById: vi.fn(async (id) => (id === "team-1" ? team({ id }) : null)),
    findTeamBySlug: vi.fn(async () => null),
    insertTeam: vi.fn(async (input) => team({ id: "team-new", ...input })),
    updateTeamStatus: vi.fn(async (id) => team({ id, status: "archived" })),
    listTeamsByOrg: vi.fn(async () => [team()]),
    findNonRevokedOrgMembership: vi.fn(async () => null),
    findNonRevokedTeamMembership: vi.fn(async () => null),
    findMembershipById: vi.fn(async (id) => membership({ id })),
    insertOrgMembership: vi.fn(async (input) =>
      membership({
        id: "m-new",
        organizationId: input.teamId !== undefined ? null : ORG,
        teamId: input.teamId ?? null,
        role: input.teamId !== undefined ? null : (input.role ?? null),
      }),
    ),
    updateMembershipStatus: vi.fn(async (id, status, revokedAt) =>
      membership({ id, status, revokedAt: revokedAt?.toISOString() ?? null }),
    ),
    listMembershipsForOrg: vi.fn(async () => []),
    listTeamAssignments: vi.fn(async () => []),
  };
  return repo;
};

const captureEvents = () => {
  const seen: { name: string; correlation: unknown; payload: unknown }[] = [];
  const publisher = new InProcessEventPublisher([
    async (envelope) => {
      seen.push({ name: envelope.name, correlation: envelope.correlation, payload: envelope.payload });
    },
  ]);
  return { publisher, seen };
};

describe("capability gating", () => {
  it("denies every mutating command without admin.permissions (fail closed)", async () => {
    const svc = createMembershipService({ repository: repoMock(), allowSequentialAudit: true });
    const weak = actor({ roles: ["viewer"], capabilities: ["audit.read"] });
    await expect(svc.createTeam(weak, { slug: "a", name: "A" })).resolves.toMatchObject({ ok: false, error: { reason: "missing_capability" } });
    await expect(svc.archiveTeam(weak, "team-1")).resolves.toMatchObject({ ok: false, error: { reason: "missing_capability" } });
    await expect(svc.listTeamAssignments(weak, "team-1", {})).resolves.toMatchObject({ ok: false, error: { reason: "missing_capability" } });
    await expect(svc.grantOrgMembership(weak, { operatorId: "op-target", role: "viewer" })).resolves.toMatchObject({ ok: false, error: { reason: "missing_capability" } });
    await expect(svc.grantTeamAssignment(weak, { operatorId: "op-target", teamId: "team-1" })).resolves.toMatchObject({ ok: false, error: { reason: "missing_capability" } });
    await expect(svc.changeMembershipStatus(weak, { membershipId: "m-1", status: "suspended" })).resolves.toMatchObject({ ok: false, error: { reason: "missing_capability" } });
    await expect(svc.revokeMembership(weak, "m-1")).resolves.toMatchObject({ ok: false, error: { reason: "missing_capability" } });
  });
});

describe("cross-org denial", () => {
  it("denies commands on operators outside the actor's organization", async () => {
    const repo = repoMock();
    vi.mocked(repo.findOperatorById).mockResolvedValue({ id: "op-foreign", orgId: "org-OTHER", status: "active" });
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.grantOrgMembership(actor(), { operatorId: "op-foreign", role: "viewer" })).resolves.toMatchObject({ ok: false, error: { reason: "cross_org" } });
    await expect(svc.grantTeamAssignment(actor(), { operatorId: "op-foreign", teamId: "team-1" })).resolves.toMatchObject({ ok: false, error: { reason: "cross_org" } });
  });

  it("denies team commands on teams outside the actor's organization", async () => {
    const repo = repoMock();
    vi.mocked(repo.findTeamById).mockResolvedValue(team({ orgId: "org-OTHER" }));
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.archiveTeam(actor(), "team-1")).resolves.toMatchObject({ ok: false, error: { reason: "cross_org" } });
    await expect(svc.grantTeamAssignment(actor(), { operatorId: "op-target", teamId: "team-1" })).resolves.toMatchObject({ ok: false, error: { reason: "cross_org" } });
    await expect(svc.listTeamAssignments(actor(), "team-1", {})).resolves.toMatchObject({ ok: false, error: { reason: "cross_org" } });
  });

  it("denies membership status changes on memberships outside the actor's organization", async () => {
    const repo = repoMock();
    vi.mocked(repo.findMembershipById).mockResolvedValue(membership({ organizationId: "org-OTHER" }));
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.changeMembershipStatus(actor(), { membershipId: "m-1", status: "suspended" })).resolves.toMatchObject({ ok: false, error: { reason: "cross_org" } });
    await expect(svc.revokeMembership(actor(), "m-1")).resolves.toMatchObject({ ok: false, error: { reason: "cross_org" } });
  });

  it("denies status changes on team-scoped memberships whose team belongs to another org", async () => {
    const repo = repoMock();
    vi.mocked(repo.findMembershipById).mockResolvedValue(membership({ organizationId: null, teamId: "team-1", role: null }));
    vi.mocked(repo.findTeamById).mockResolvedValue(team({ orgId: "org-OTHER" }));
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.changeMembershipStatus(actor(), { membershipId: "m-1", status: "suspended" })).resolves.toMatchObject({ ok: false, error: { reason: "cross_org" } });
  });
});

describe("privilege-escalation guards", () => {
  it("rejects self-grant, self-status-change, and self-revocation", async () => {
    const svc = createMembershipService({ repository: repoMock(), allowSequentialAudit: true });
    const self = actor({ operatorId: "op-target" });
    await expect(svc.grantOrgMembership(self, { operatorId: "op-target", role: "viewer" })).resolves.toMatchObject({ ok: false, error: { reason: "self_grant" } });
    await expect(svc.grantTeamAssignment(self, { operatorId: "op-target", teamId: "team-1" })).resolves.toMatchObject({ ok: false, error: { reason: "self_grant" } });
    await expect(svc.changeMembershipStatus(self, { membershipId: "m-1", status: "suspended" })).resolves.toMatchObject({ ok: false, error: { reason: "self_grant" } });
    await expect(svc.revokeMembership(self, "m-1")).resolves.toMatchObject({ ok: false, error: { reason: "self_grant" } });
  });

  it("rejects granting a role above the actor's rank", async () => {
    const svc = createMembershipService({ repository: repoMock(), allowSequentialAudit: true });
    const op = actor({ roles: ["operator"], capabilities: ["admin.permissions"] });
    await expect(svc.grantOrgMembership(op, { operatorId: "op-target", role: "admin" })).resolves.toMatchObject({ ok: false, error: { reason: "role_escalation" } });
    const reviewer = actor({ roles: ["reviewer"], capabilities: ["admin.permissions"] });
    await expect(svc.grantOrgMembership(reviewer, { operatorId: "op-target", role: "operator" })).resolves.toMatchObject({ ok: false, error: { reason: "role_escalation" } });
  });

  it("rejects a non-admin minting an admin even when ranks tie", async () => {
    const svc = createMembershipService({ repository: repoMock(), allowSequentialAudit: true });
    const rogueAdmin = actor({ roles: ["operator"], capabilities: ["admin.permissions"] });
    await expect(svc.grantOrgMembership(rogueAdmin, { operatorId: "op-target", role: "admin" })).resolves.toMatchObject({ ok: false, error: { reason: "role_escalation" } });
  });

  it("ROLE_RANK is strictly ordered", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.reviewer);
    expect(ROLE_RANK.reviewer).toBeLessThan(ROLE_RANK.operator);
    expect(ROLE_RANK.operator).toBeLessThan(ROLE_RANK.admin);
  });
});

describe("grant semantics", () => {
  it("grants an org membership within the actor's rank and emits membership.granted", async () => {
    const repo = repoMock();
    const { publisher, seen } = captureEvents();
    const audit = vi.fn(async () => {});
    const svc = createMembershipService({ repository: repo, publisher, auditAppend: audit, allowSequentialAudit: true });
    const result = await svc.grantOrgMembership(actor({ roles: ["admin"] }), { operatorId: "op-target", role: "operator" });
    expect(result).toMatchObject({ ok: true, value: { role: "operator", organizationId: ORG } });
    expect(seen).toEqual([
      expect.objectContaining({
        name: "membership.granted",
        correlation: { organizationId: ORG },
        payload: expect.objectContaining({ scope: "organization", role: "operator" }),
      }),
    ]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "membership.granted", targetType: "membership" }));
  });

  it("rejects a grant when a non-revoked membership already exists (conflict)", async () => {
    const repo = repoMock();
    vi.mocked(repo.findNonRevokedOrgMembership).mockResolvedValue(membership());
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.grantOrgMembership(actor(), { operatorId: "op-target", role: "viewer" })).resolves.toMatchObject({ ok: false, error: { reason: "membership_conflict" } });
  });

  it("rejects grants when the organization is not active (fail closed)", async () => {
    const repo = repoMock();
    vi.mocked(repo.findOrganizationStatus).mockResolvedValue("suspended");
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.grantOrgMembership(actor(), { operatorId: "op-target", role: "viewer" })).resolves.toMatchObject({ ok: false, error: { reason: "org_not_active" } });
  });

  it("rejects grants to inactive operators", async () => {
    const repo = repoMock();
    vi.mocked(repo.findOperatorById).mockResolvedValue({ id: "op-target", orgId: ORG, status: "suspended" });
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.grantOrgMembership(actor(), { operatorId: "op-target", role: "viewer" })).resolves.toMatchObject({ ok: false, error: { reason: "operator_not_active" } });
  });
});

describe("team assignment semantics (D-3: assignment-only)", () => {
  it("inserts team rows WITHOUT any role and marks scope=team in the event", async () => {
    const repo = repoMock();
    const { publisher, seen } = captureEvents();
    const svc = createMembershipService({ repository: repo, publisher, allowSequentialAudit: true });
    const result = await svc.grantTeamAssignment(actor(), { operatorId: "op-target", teamId: "team-1" });
    expect(result).toMatchObject({ ok: true, value: { teamId: "team-1", role: null } });
    const insert = vi.mocked(repo.insertOrgMembership).mock.calls[0]?.[0];
    if (!insert) throw new Error("insertOrgMembership was not called");
    expect(insert.teamId).toBe("team-1");
    expect(insert.role).toBeUndefined(); // D-3: no role is ever transmitted for team rows
    expect(seen).toEqual([
      expect.objectContaining({ name: "membership.granted", payload: expect.objectContaining({ scope: "team" }) }),
    ]);
  });

  it("rejects team assignment on an archived team", async () => {
    const repo = repoMock();
    vi.mocked(repo.findTeamById).mockResolvedValue(team({ status: "archived" }));
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.grantTeamAssignment(actor(), { operatorId: "op-target", teamId: "team-1" })).resolves.toMatchObject({ ok: false, error: { reason: "team_not_active" } });
  });
});

describe("status transitions and append-and-revoke history", () => {
  it("permits only approved transitions", async () => {
    const svc = createMembershipService({ repository: repoMock(), allowSequentialAudit: true });
    // The type system itself forbids 'revoked' via changeMembershipStatus:
    // @ts-expect-error revoked is excluded from the input type by design
    await expect(svc.changeMembershipStatus(actor(), { membershipId: "m-1", status: "revoked" })).resolves.toMatchObject({ ok: false });
    const repo = repoMock();
    vi.mocked(repo.findMembershipById).mockResolvedValue(membership({ status: "revoked", revokedAt: "2026-09-16T00:00:00.000Z" }));
    const svc2 = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc2.changeMembershipStatus(actor(), { membershipId: "m-1", status: "active" })).resolves.toMatchObject({ ok: false, error: { reason: "invalid_transition" } });
  });

  it("revocation sets revokedAt, emits membership.revoked, and re-grant then inserts a NEW row", async () => {
    const repo = repoMock();
    const { publisher, seen } = captureEvents();
    const svc = createMembershipService({ repository: repo, publisher, allowSequentialAudit: true });
    const revoked = await svc.revokeMembership(actor(), "m-1");
    expect(revoked).toMatchObject({ ok: true, value: { status: "revoked" } });
    expect(vi.mocked(repo.updateMembershipStatus).mock.calls[0]).toEqual(["m-1", "revoked", expect.any(Date)]);
    expect(seen).toEqual([
      expect.objectContaining({ name: "membership.revoked" }),
    ]);

    // history preserved: after revoke the conflict lookup finds nothing -> grant inserts anew
    vi.mocked(repo.findNonRevokedOrgMembership).mockResolvedValue(null);
    const regrant = await svc.grantOrgMembership(actor(), { operatorId: "op-target", role: "viewer" });
    expect(regrant).toMatchObject({ ok: true, value: { id: "m-new" } });
  });

  it("refuses to mutate an already-revoked membership (immutable history)", async () => {
    const repo = repoMock();
    vi.mocked(repo.findMembershipById).mockResolvedValue(membership({ status: "revoked", revokedAt: "2026-09-16T00:00:00.000Z" }));
    const svc = createMembershipService({ repository: repo, allowSequentialAudit: true });
    await expect(svc.revokeMembership(actor(), "m-1")).resolves.toMatchObject({ ok: false, error: { reason: "invalid_transition" } });
  });
});

describe("teams lifecycle", () => {
  it("creates a team with kebab-case slug validation and emits team.created", async () => {
    const { publisher, seen } = captureEvents();
    const svc = createMembershipService({ repository: repoMock(), publisher, allowSequentialAudit: true });
    await expect(svc.createTeam(actor(), { slug: "Bad Slug", name: "X" })).resolves.toMatchObject({ ok: false, error: { reason: "invalid_request" } });
    const ok = await svc.createTeam(actor(), { slug: "alpha-team", name: "Alpha" });
    expect(ok).toMatchObject({ ok: true, value: { slug: "alpha-team" } });
    expect(seen).toEqual([
      expect.objectContaining({ name: "team.created", correlation: expect.objectContaining({ organizationId: ORG }) }),
    ]);
  });

  it("archives a team and emits team.archived", async () => {
    const { publisher, seen } = captureEvents();
    const svc = createMembershipService({ repository: repoMock(), publisher, allowSequentialAudit: true });
    await expect(svc.archiveTeam(actor(), "team-1")).resolves.toMatchObject({ ok: true, value: { status: "archived" } });
    expect(seen).toEqual([expect.objectContaining({ name: "team.archived" })]);
  });
});

describe("D2.4-1 fail-closed guard", () => {
  it("REFUSES to mutate when the repository lacks runInTransaction and the sequential fallback is not explicitly enabled", async () => {
    const svc = createMembershipService({ repository: repoMock() }); // no allowSequentialAudit
    await expect(svc.createTeam(actor(), { slug: "guard-team", name: "Guard" })).rejects.toThrow(
      /D2\.4-1 violation/,
    );
    await expect(svc.grantOrgMembership(actor(), { operatorId: "op-target", role: "operator" })).rejects.toThrow(
      /D2\.4-1 violation/,
    );
  });

  it("prefers the same-transaction path when the repository implements runInTransaction, even with the test-only flag set", async () => {
    const repo = repoMock();
    let seqAuditCalls = 0;
    let txCalls = 0;
    const runInTransaction = async <T,>(
      fn: (tx: MembershipTransaction) => Promise<T>,
    ): Promise<T> => {
      txCalls += 1;
      return fn({
        insertTeam: repo.insertTeam,
        updateTeamStatus: repo.updateTeamStatus,
        insertOrgMembership: repo.insertOrgMembership,
        updateMembershipStatus: repo.updateMembershipStatus,
        appendAudit: vi.fn(async () => {}),
      });
    };
    const txRepo: MembershipRepository = { ...repo, runInTransaction };
    const svc = createMembershipService({
      repository: txRepo,
      allowSequentialAudit: true, // flag set but must be irrelevant here
      auditAppend: vi.fn(async () => {
        seqAuditCalls += 1;
      }),
    });
    const result = await svc.createTeam(actor(), { slug: "tx-team", name: "Tx" });
    expect(result).toMatchObject({ ok: true });
    expect(txCalls).toBe(1); // transaction port used
    expect(seqAuditCalls).toBe(0); // sequential fallback never invoked
  });
});
