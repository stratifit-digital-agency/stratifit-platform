/**
 * Membership & teams service (Stage 2.2 decisions D-1..D-5; Stage 2.4 D2.4-1).
 *
 * Commands enforce, in order: capability (`admin.permissions`) -> actor
 * authority -> target/state validity -> invariant checks -> persistence ->
 * post-commit event publication (Stage-1 semantics).
 *
 * D2.4-1 (Option A): every security-critical mutation and its audit record
 * commit inside the SAME database transaction via
 * `MembershipRepository.runInTransaction` — a crash before COMMIT rolls back
 * BOTH, and a successful mutation cannot commit without its audit record.
 * Repositories without transaction support fall back to the Stage-2.2
 * sequential seam (persist -> standalone audit), the documented pre-2.4
 * behavior. Domain events are always published AFTER commit.
 *
 * D-3: team assignments structurally carry no role/authorization. D-1:
 * org-scoped membership role is the sole authorization authority. History is
 * append-and-revoke (DM section 6): revoke ends a row; re-grant inserts anew.
 */
import { randomUUID } from "node:crypto";
import type { OperatorRole } from "@stratifit/auth";
import type { ControlCapability } from "@stratifit/permissions";
import { emitEvent, InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  AuditAppend,
  MembershipActor,
  MembershipCommandErrorReason,
  MembershipCommandResult,
  MembershipRecord,
  MembershipRepository,
  MembershipStatus,
  MembershipTransaction,
  TeamRecord,
} from "./types";

export const ROLE_RANK: Record<OperatorRole, number> = {
  viewer: 0,
  reviewer: 1,
  operator: 2,
  admin: 3,
};

export interface MembershipServiceDeps {
  repository: MembershipRepository;
  /** Defaults to an in-process publisher with no handlers (Stage-1 semantics). */
  publisher?: EventPublisher;
  /** Fallback D4 seam (used only when the repository has no transaction support). */
  auditAppend?: AuditAppend;
  /**
   * TEST-ONLY: permit the sequential (non-transactional) audit fallback for
   * repositories without `runInTransaction`. Production composition roots
   * never set it — there the service fail-closes instead (D2.4-1).
   */
  allowSequentialAudit?: boolean;
  eventIdFactory?: () => string;
}

export interface MembershipService {
  listTeams(actor: MembershipActor): Promise<TeamRecord[]>;
  createTeam(
    actor: MembershipActor,
    input: { slug: string; name: string },
  ): Promise<MembershipCommandResult<TeamRecord>>;
  archiveTeam(actor: MembershipActor, teamId: string): Promise<MembershipCommandResult<TeamRecord>>;
  listMembers(actor: MembershipActor, input: { includeRevoked?: boolean }): Promise<MembershipRecord[]>;
  listTeamAssignments(
    actor: MembershipActor,
    teamId: string,
    input: { includeRevoked?: boolean },
  ): Promise<MembershipCommandResult<MembershipRecord[]>>;
  grantOrgMembership(
    actor: MembershipActor,
    input: { operatorId: string; role: OperatorRole },
  ): Promise<MembershipCommandResult<MembershipRecord>>;
  grantTeamAssignment(
    actor: MembershipActor,
    input: { operatorId: string; teamId: string },
  ): Promise<MembershipCommandResult<MembershipRecord>>;
  changeMembershipStatus(
    actor: MembershipActor,
    input: { membershipId: string; status: Exclude<MembershipStatus, "revoked"> },
  ): Promise<MembershipCommandResult<MembershipRecord>>;
  revokeMembership(
    actor: MembershipActor,
    membershipId: string,
  ): Promise<MembershipCommandResult<MembershipRecord>>;
}

export const ROLE_ACTION: ControlCapability = "admin.permissions";

type AuditEntryInput = Parameters<AuditAppend>[0];

export const createMembershipService = (deps: MembershipServiceDeps): MembershipService => {
  const repo = deps.repository;
  const publisher = deps.publisher ?? new InProcessEventPublisher();
  const fallbackAudit = deps.auditAppend ?? (async () => {});
  const nextEventId = deps.eventIdFactory ?? (() => randomUUID());

  const err = (reason: MembershipCommandErrorReason, message: string) => ({ ok: false as const, error: { reason, message } });

  const requireCapability = (actor: MembershipActor) =>
    actor.capabilities.includes(ROLE_ACTION)
      ? null
      : err("missing_capability", `${ROLE_ACTION} capability required`);

  const emit = async (
    name: "membership.granted" | "membership.revoked" | "membership.updated" | "team.created" | "team.archived",
    payload: Record<string, unknown>,
    organizationId?: string | null,
  ) => {
    await emitEvent(publisher, {
      eventId: nextEventId(),
      name,
      correlation: organizationId ? { organizationId } : {},
      payload,
    });
  };

  const auditEntry = (
    actor: MembershipActor,
    action: string,
    targetType: "membership" | "team",
    targetId: string,
    metadata?: Record<string, unknown>,
  ): AuditEntryInput => ({
    actorId: actor.operatorId,
    action,
    targetType,
    targetId,
    // D2.4-2: the acting operator's org scopes the audit record.
    organizationId: actor.organizationId,
    ...(metadata === undefined ? {} : { metadata }),
    correlationId: actor.correlationId ?? null,
    causationId: null,
  });

  /**
   * D2.4-1 dispatch: run `run` (the mutation) and its audit append inside ONE
   * database transaction when the repository supports it; otherwise use the
   * sequential Stage-2.2 fallback. The audit record describes the persisted
   * value, so `describe` sees the actual row after the mutation.
   */
  const persistAndAudit = async <T>(
    actor: MembershipActor,
    action: string,
    targetType: "membership" | "team",
    describe: (value: T) => { targetId: string; metadata?: Record<string, unknown> },
    run: (tx: MembershipTransaction) => Promise<T>,
  ): Promise<T> => {
    if (repo.runInTransaction) {
      return repo.runInTransaction(async (tx) => {
        const value = await run(tx);
        const { targetId, metadata } = describe(value);
        await tx.appendAudit(auditEntry(actor, action, targetType, targetId, metadata));
        return value;
      });
    }
    // D2.4-1: production repositories implement runInTransaction, so mutation
    // + audit ALWAYS commit atomically. The sequential fallback exists solely
    // for isolated test fakes and must be enabled explicitly (test-only flag);
    // production composition roots never set it. Fail closed otherwise — a
    // mutation must never commit without its required audit record.
    if (deps.allowSequentialAudit !== true) {
      throw new Error(
        "D2.4-1 violation: repository does not implement runInTransaction; " +
          "membership mutations cannot commit without a same-transaction audit " +
          "record. (The sequential audit fallback is test-only and must be " +
          "enabled explicitly via allowSequentialAudit.)",
      );
    }
    const fallbackTx: MembershipTransaction = {
      insertTeam: (input) => repo.insertTeam(input),
      updateTeamStatus: (teamId, status) => repo.updateTeamStatus(teamId, status),
      insertOrgMembership: (input) => repo.insertOrgMembership(input),
      updateMembershipStatus: (id, status, revokedAt) => repo.updateMembershipStatus(id, status, revokedAt),
      appendAudit: (entry) => fallbackAudit(entry),
    };
    const value = await run(fallbackTx);
    const { targetId, metadata } = describe(value);
    await fallbackAudit(auditEntry(actor, action, targetType, targetId, metadata));
    return value;
  };

  return {
    async listTeams(actor) {
      return repo.listTeamsByOrg(actor.organizationId);
    },

    async createTeam(actor, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
        return err("invalid_request", "team slug must be lowercase kebab-case");
      }
      const existing = await repo.findTeamBySlug(actor.organizationId, input.slug);
      if (existing) return err("invalid_request", `team slug '${input.slug}' already exists in this organization`);

      const team = await persistAndAudit<TeamRecord>(
        actor,
        "team.created",
        "team",
        (t) => ({ targetId: t.id, metadata: { slug: t.slug } }),
        (tx) => tx.insertTeam({ orgId: actor.organizationId, slug: input.slug, name: input.name }),
      );
      await emit("team.created", { teamId: team.id, slug: team.slug, name: team.name }, actor.organizationId);
      return { ok: true, value: team };
    },

    async archiveTeam(actor, teamId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const team = await repo.findTeamById(teamId);
      if (!team || team.orgId !== actor.organizationId) return err("cross_org", "team does not belong to your organization");
      if (team.status === "archived") return err("invalid_transition", "team is already archived");

      const updated = await persistAndAudit<TeamRecord>(
        actor,
        "team.archived",
        "team",
        (t) => ({ targetId: t.id, metadata: { slug: t.slug } }),
        (tx) => tx.updateTeamStatus(teamId, "archived"),
      );
      await emit("team.archived", { teamId: updated.id, slug: updated.slug }, actor.organizationId);
      return { ok: true, value: updated };
    },

    async listMembers(actor, input) {
      return repo.listMembershipsForOrg(actor.organizationId, input?.includeRevoked ?? false);
    },

    async listTeamAssignments(actor, teamId, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const team = await repo.findTeamById(teamId);
      if (!team || team.orgId !== actor.organizationId) return err("cross_org", "team does not belong to your organization");
      return { ok: true, value: await repo.listTeamAssignments(teamId, input?.includeRevoked ?? false) };
    },

    async grantOrgMembership(actor, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;

      // Escalation guard 1: self-grant (no operator may alter their own grants).
      if (input.operatorId === actor.operatorId) {
        return err("self_grant", "operators cannot grant or change their own memberships");
      }
      // Escalation guard 2: role authority.
      const actorRank = Math.max(...actor.roles.map((r) => ROLE_RANK[r]));
      if (ROLE_RANK[input.role] > actorRank) {
        return err("role_escalation", `cannot grant a role higher than the actor's authority`);
      }
      // Only admins may mint admins.
      if (input.role === "admin" && !actor.roles.includes("admin")) {
        return err("role_escalation", "only admins can grant the admin role");
      }

      const target = await repo.findOperatorById(input.operatorId);
      if (!target || target.orgId !== actor.organizationId) {
        return err("cross_org", "target operator does not belong to your organization");
      }
      if (target.status !== "active") return err("operator_not_active", "target operator is not active");

      const orgStatus = await repo.findOrganizationStatus(actor.organizationId);
      if (orgStatus !== "active") return err("org_not_active", "organization is not active");

      const conflict = await repo.findNonRevokedOrgMembership(input.operatorId, actor.organizationId);
      if (conflict) {
        return err(
          "membership_conflict",
          "operator already has a non-revoked organization membership; change its status instead",
        );
      }

      const record = await persistAndAudit<MembershipRecord>(
        actor,
        "membership.granted",
        "membership",
        (r) => ({ targetId: r.id, metadata: { operatorId: r.operatorId, role: r.role } }),
        (tx) =>
          tx.insertOrgMembership({
            operatorId: input.operatorId,
            organizationId: actor.organizationId,
            role: input.role,
            grantedBy: actor.operatorId,
          }),
      );
      await emit(
        "membership.granted",
        { membershipId: record.id, operatorId: record.operatorId, role: record.role, scope: "organization" },
        actor.organizationId,
      );
      return { ok: true, value: record };
    },

    async grantTeamAssignment(actor, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (input.operatorId === actor.operatorId) {
        return err("self_grant", "operators cannot grant or change their own memberships");
      }

      const team = await repo.findTeamById(input.teamId);
      if (!team || team.orgId !== actor.organizationId) return err("cross_org", "team does not belong to your organization");
      if (team.status !== "active") return err("team_not_active", "team is not active");

      const target = await repo.findOperatorById(input.operatorId);
      if (!target || target.orgId !== actor.organizationId) {
        return err("cross_org", "target operator does not belong to your organization");
      }
      if (target.status !== "active") return err("operator_not_active", "target operator is not active");

      const orgStatus = await repo.findOrganizationStatus(actor.organizationId);
      if (orgStatus !== "active") return err("org_not_active", "organization is not active");

      const conflict = await repo.findNonRevokedTeamMembership(input.operatorId, input.teamId);
      if (conflict) return err("membership_conflict", "operator already has a non-revoked assignment to this team");

      // D-3: team rows carry NO role (structurally impossible in the schema).
      const record = await persistAndAudit<MembershipRecord>(
        actor,
        "membership.granted",
        "membership",
        (r) => ({ targetId: r.id, metadata: { operatorId: r.operatorId, teamId: r.teamId } }),
        (tx) =>
          tx.insertOrgMembership({
            operatorId: input.operatorId,
            teamId: input.teamId,
            grantedBy: actor.operatorId,
          }),
      );
      await emit(
        "membership.granted",
        { membershipId: record.id, operatorId: record.operatorId, teamId: record.teamId, scope: "team" },
        actor.organizationId,
      );
      return { ok: true, value: record };
    },

    async changeMembershipStatus(actor, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;

      const membership = await repo.findMembershipById(input.membershipId);
      if (!membership) return err("membership_not_found", "membership not found");
      if (membership.operatorId === actor.operatorId) {
        return err("self_grant", "operators cannot change their own membership status");
      }
      const scopeOrg =
        membership.organizationId ??
        (await (async () => {
          const team = membership.teamId ? await repo.findTeamById(membership.teamId) : null;
          return team?.orgId ?? null;
        })());
      if (!scopeOrg || scopeOrg !== actor.organizationId) return err("cross_org", "membership is outside your organization");
      if (membership.status === "revoked") return err("invalid_transition", "revoked memberships are immutable history");

      const allowed: Record<string, string[]> = {
        active: ["inactive", "suspended"],
        inactive: ["active", "suspended"],
        suspended: ["active", "inactive"],
      };
      if (!(allowed[membership.status] ?? []).includes(input.status)) {
        return err("invalid_transition", `cannot move membership from ${membership.status} to ${input.status}`);
      }

      const updated = await persistAndAudit<MembershipRecord>(
        actor,
        "membership.updated",
        "membership",
        (r) => ({ targetId: r.id, metadata: { from: membership.status, to: r.status } }),
        (tx) => tx.updateMembershipStatus(input.membershipId, input.status, null),
      );
      await emit(
        "membership.updated",
        { membershipId: updated.id, operatorId: updated.operatorId, status: updated.status, previousStatus: membership.status },
        actor.organizationId,
      );
      return { ok: true, value: updated };
    },

    async revokeMembership(actor, membershipId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;

      const membership = await repo.findMembershipById(membershipId);
      if (!membership) return err("membership_not_found", "membership not found");
      if (membership.operatorId === actor.operatorId) {
        return err("self_grant", "operators cannot revoke their own membership");
      }
      const scopeOrg =
        membership.organizationId ??
        (await (async () => {
          const team = membership.teamId ? await repo.findTeamById(membership.teamId) : null;
          return team?.orgId ?? null;
        })());
      if (!scopeOrg || scopeOrg !== actor.organizationId) return err("cross_org", "membership is outside your organization");
      if (membership.status === "revoked") return err("invalid_transition", "membership is already revoked");

      const updated = await persistAndAudit<MembershipRecord>(
        actor,
        "membership.revoked",
        "membership",
        (r) => ({ targetId: r.id, metadata: { operatorId: r.operatorId } }),
        (tx) => tx.updateMembershipStatus(membershipId, "revoked", new Date()),
      );
      await emit(
        "membership.revoked",
        { membershipId: updated.id, operatorId: updated.operatorId, role: updated.role, teamId: updated.teamId },
        actor.organizationId,
      );
      return { ok: true, value: updated };
    },
  };
};
