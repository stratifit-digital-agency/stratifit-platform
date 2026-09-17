import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import type { MembershipActor } from "@stratifit/identity";
import {
  AuditTrailQuery,
  ChangeMembershipStatusRequest,
  CreateTeamRequest,
  GrantOrgMembershipRequest,
  GrantTeamAssignmentRequest,
} from "@stratifit/contracts";
import { capabilitiesFor, resolveControlOperator, getMembershipService, getAuditService } from "@/lib/identity";
import { apiError, apiOk, membershipError, newCorrelationId } from "./api";
import type { ControlOperatorContext } from "@/lib/identity";

/**
 * Command handlers for the /api/control/admin/* BFF surface.
 *
 * Flow per API_ARCHITECTURE section 11: resolveControlOperator() -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> owning service
 * -> section 13 error envelope. Handlers are thin and unit-testable; the HTTP
 * route files stay adapters.
 */

export interface AuthedContext {
  readonly actor: MembershipActor;
  readonly correlationId: string;
}

export interface AuthError {
  readonly response: NextResponse;
}

/** Server-derived MembershipActor from the resolved operator context. */
export const toMembershipActor = (context: ControlOperatorContext): MembershipActor => ({
  operatorId: context.identity.userId,
  organizationId: context.organizationId,
  roles: context.roles,
  capabilities: capabilitiesFor(context.roles),
  correlationId: null,
});

/**
 * Resolve + authenticate + authorize for `capability`. Returns the authenticated
 * context, or an AuthError carrying the section 13 envelope response.
 */
export const authorizeAdminRequest = async (
  capability: ControlCapability,
  request?: Request,
): Promise<AuthedContext | AuthError> => {
  const correlationId = request?.headers.get("x-correlation-id") ?? newCorrelationId();
  const operator = await resolveControlOperator();
  if (!operator) {
    return { response: apiError("unauthenticated", "operator session required", correlationId, { status: 401 }) };
  }
  if (!operator.capabilities.includes(capability)) {
    return { response: apiError("forbidden", `${capability} capability required`, correlationId, { status: 403 }) };
  }
  return { actor: toMembershipActor(operator), correlationId };
};

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a contracts ZodError to the section 13 validation envelope. */
const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

export const handleCreateTeam = async (request: Request) => {
  const auth = await authorizeAdminRequest("admin.permissions", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateTeamRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMembershipService().createTeam(auth.actor, parsed.data);
  return result.ok
    ? apiOk(result.value, 201)
    : membershipError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleArchiveTeam = async (request: Request, teamId: string) => {
  const auth = await authorizeAdminRequest("admin.permissions", request);
  if (isAuthError(auth)) return auth.response;
  const result = await getMembershipService().archiveTeam(auth.actor, teamId);
  return result.ok
    ? apiOk(result.value)
    : membershipError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleListTeams = async (request: Request) => {
  const auth = await authorizeAdminRequest("admin.permissions", request);
  if (isAuthError(auth)) return auth.response;
  const teams = await getMembershipService().listTeams(auth.actor);
  return apiOk({ teams });
};

export const handleListMembers = async (request: Request) => {
  const auth = await authorizeAdminRequest("admin.permissions", request);
  if (isAuthError(auth)) return auth.response;
  const includeRevoked = new URL(request.url).searchParams.get("includeRevoked") === "true";
  const members = await getMembershipService().listMembers(auth.actor, { includeRevoked });
  return apiOk({ members });
};

export const handleGrantOrgMembership = async (request: Request) => {
  const auth = await authorizeAdminRequest("admin.permissions", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = GrantOrgMembershipRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMembershipService().grantOrgMembership(auth.actor, parsed.data);
  return result.ok
    ? apiOk(result.value, 201)
    : membershipError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleGrantTeamAssignment = async (request: Request) => {
  const auth = await authorizeAdminRequest("admin.permissions", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = GrantTeamAssignmentRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMembershipService().grantTeamAssignment(auth.actor, parsed.data);
  return result.ok
    ? apiOk(result.value, 201)
    : membershipError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleChangeMembershipStatus = async (request: Request, membershipId: string) => {
  const auth = await authorizeAdminRequest("admin.permissions", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = ChangeMembershipStatusRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMembershipService().changeMembershipStatus(auth.actor, {
    membershipId,
    status: parsed.data.status,
  });
  return result.ok
    ? apiOk(result.value)
    : membershipError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleRevokeMembership = async (request: Request, membershipId: string) => {
  const auth = await authorizeAdminRequest("admin.permissions", request);
  if (isAuthError(auth)) return auth.response;
  const result = await getMembershipService().revokeMembership(auth.actor, membershipId);
  return result.ok
    ? apiOk(result.value)
    : membershipError(result.error.reason, result.error.message, auth.correlationId);
};

/** GET /api/control/admin/audit — org-scoped audit trail (D2.4-2). */
export const handleAuditTrail = async (request: Request) => {
  const auth = await authorizeAdminRequest("audit.read", request);
  if (isAuthError(auth)) return auth.response;
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = AuditTrailQuery.safeParse(params);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const { action, subjectKind, subjectId, actorId, direction, cursor, limit } = parsed.data;
  const page = await getAuditService().queryOrgAudit({
    organizationId: auth.actor.organizationId,
    // exactOptionalPropertyTypes: only defined filters are passed through.
    ...(action !== undefined ? { action } : {}),
    ...(subjectKind !== undefined ? { subjectKind } : {}),
    ...(subjectId !== undefined ? { subjectId } : {}),
    ...(actorId !== undefined ? { actorId } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  return apiOk({ entries: page.entries, nextCursor: page.nextCursor });
};
