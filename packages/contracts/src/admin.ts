import { z } from "zod";

/**
 * Control administration contracts (Stage 2.4).
 *
 * Shapes for the /api/control/admin/* BFF surface: team administration,
 * membership administration, and the audit-trail query. These are transport
 * validation only — capability checks (`admin.permissions`, `audit.read`),
 * org boundaries, escalation guards, and state-machine rules remain
 * server-side in the owning services (services/identity, services/admin-audit).
 */

export const TeamSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case");
export type TeamSlug = z.infer<typeof TeamSlug>;

export const CreateTeamRequest = z.object({
  slug: TeamSlug,
  name: z.string().min(1).max(120),
});
export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>;

export const OrgRole = z.enum(["admin", "operator", "reviewer", "viewer"]);
export type OrgRole = z.infer<typeof OrgRole>;

export const GrantOrgMembershipRequest = z.object({
  operatorId: z.string().uuid(),
  role: OrgRole,
});
export type GrantOrgMembershipRequest = z.infer<typeof GrantOrgMembershipRequest>;

export const GrantTeamAssignmentRequest = z.object({
  operatorId: z.string().uuid(),
  teamId: z.string().uuid(),
});
export type GrantTeamAssignmentRequest = z.infer<typeof GrantTeamAssignmentRequest>;

export const MembershipStatusValue = z.enum(["active", "inactive", "suspended"]);
export type MembershipStatusValue = z.infer<typeof MembershipStatusValue>;

export const ChangeMembershipStatusRequest = z.object({
  status: MembershipStatusValue,
});
export type ChangeMembershipStatusRequest = z.infer<typeof ChangeMembershipStatusRequest>;

export const AuditTrailQuery = z.object({
  action: z.string().min(1).max(200).optional(),
  subjectKind: z.string().min(1).max(60).optional(),
  subjectId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type AuditTrailQuery = z.infer<typeof AuditTrailQuery>;

/** Single paginated page of the org-scoped audit trail (D2.4-2). */
export const AuditTrailResponse = z.object({
  entries: z.array(
    z.object({
      id: z.string().uuid(),
      actorId: z.string().uuid(),
      action: z.string(),
      subjectKind: z.string(),
      subjectId: z.string().uuid(),
      organizationId: z.string().uuid().nullable(),
      correlationId: z.string().nullable(),
      causationId: z.string().nullable(),
      payload: z.record(z.string(), z.unknown()),
      occurredAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type AuditTrailResponse = z.infer<typeof AuditTrailResponse>;
