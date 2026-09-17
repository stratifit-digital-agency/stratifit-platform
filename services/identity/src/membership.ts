/**
 * Membership & teams service (Stage 2.2, approved decisions D-1..D-5).
 *
 * Commands enforce, in order: capability (`admin.permissions`) -> actor
 * authority -> target/state validity -> invariant checks -> persistence ->
 * post-commit event publication (Stage-1 semantics) -> D4 audit seam (no-op
 * stub until admin-audit exists).
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
  /** D4 seam; default is an explicit no-op until admin-audit is implemented. */
  auditAppend?: AuditAppend;
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

export const createMembershipService = (deps: MembershipServiceDeps): MembershipService => {
  const repo = deps.repository;
  const publisher = deps.publisher ?? new InProcessEventPublisher();
  const audit = deps.auditAppend ?? (async () => {});
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
    actorId: string,
    action: string,
    targetType: "membership" | "team",
    targetId: string,
    metadata?: Record<string, unknown>,
  ) =>
    metadata === undefined
      ? audit({ actorId, action, targetType, targetId })
      : audit({ actorId, action, targetType, targetId, metadata });

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
      const team = await repo.insertTeam({ orgId: actor.organizationId, slug: input.slug, name: input.name });
      await emit("team.created", { teamId: team.id, slug: team.slug, name: team.name }, actor.organizationId);
      await auditEntry(actor.operatorId, "team.created", "team", team.id, { slug: team.slug });
      return { ok: true, value: team };
    },

    async archiveTeam(actor, teamId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const team = await repo.findTeamById(teamId);
      if (!team || team.orgId !== actor.organizationId) return err("cross_org", "team does not belong to your organization");
      if (team.status === "archived") return err("invalid_transition", "team is already archived");
      const updated = await repo.updateTeamStatus(teamId, "archived");
      await emit("team.archived", { teamId: updated.id, slug: updated.slug }, actor.organizationId);
      await auditEntry(actor.operatorId, "team.archived", "team", updated.id, { slug: updated.slug });
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

      const record = await repo.insertOrgMembership({
        operatorId: input.operatorId,
        organizationId: actor.organizationId,
        role: input.role,
        grantedBy: actor.operatorId,
      });
      await emit(
        "membership.granted",
        { membershipId: record.id, operatorId: record.operatorId, role: record.role, scope: "organization" },
        actor.organizationId,
      );
      await auditEntry(actor.operatorId, "membership.granted", "membership", record.id, {
        operatorId: record.operatorId,
        role: record.role,
      });
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
      const record = await repo.insertOrgMembership({
        operatorId: input.operatorId,
        teamId: input.teamId,
        grantedBy: actor.operatorId,
      });
      await emit(
        "membership.granted",
        { membershipId: record.id, operatorId: record.operatorId, teamId: record.teamId, scope: "team" },
        actor.organizationId,
      );
      await auditEntry(actor.operatorId, "membership.granted", "membership", record.id, {
        operatorId: record.operatorId,
        teamId: record.teamId,
      });
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

      const updated = await repo.updateMembershipStatus(input.membershipId, input.status, null);
      await emit(
        "membership.updated",
        { membershipId: updated.id, operatorId: updated.operatorId, status: updated.status, previousStatus: membership.status },
        actor.organizationId,
      );
      await auditEntry(actor.operatorId, "membership.updated", "membership", updated.id, {
        from: membership.status,
        to: updated.status,
      });
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

      const updated = await repo.updateMembershipStatus(membershipId, "revoked", new Date());
      await emit(
        "membership.revoked",
        { membershipId: updated.id, operatorId: updated.operatorId, role: updated.role, teamId: updated.teamId },
        actor.organizationId,
      );
      await auditEntry(actor.operatorId, "membership.revoked", "membership", updated.id, {
        operatorId: updated.operatorId,
      });
      return { ok: true, value: updated };
    },
  };
};
