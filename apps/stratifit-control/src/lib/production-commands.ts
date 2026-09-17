import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import type { ProductionActor } from "@stratifit/production-engine";
import {
  CreateProductionRequest,
  CreateProjectRequest,
  GateEvaluationRequest,
  RecordPlanVersionRequest,
} from "@stratifit/contracts";
import { z } from "zod";
import {
  authorizeAdminRequest,
  toMembershipActor,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getProductionService } from "./identity";

/**
 * Command handlers for the Stage 2.6 /api/control/{projects,productions}
 * BFF surface (approved D2.6-3, 7 route files / 10 operations).
 *
 * Flow per API_ARCHITECTURE section 11: resolveControlOperator() -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> owning service
 * (services/production-engine) -> section 13 error envelope. Handlers are
 * thin and unit-testable; the HTTP route files stay adapters. No domain
 * business logic lives here.
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a production-command error reason to the section 13 error envelope. */
export const productionError = (
  reason: string,
  message: string,
  correlationId: string,
): NextResponse => {
  switch (reason) {
    case "missing_capability":
      return apiError("forbidden", message, correlationId);
    case "cross_org":
    case "project_not_found":
    case "production_not_found":
    case "plan_version_not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "invalid_request":
    case "duplicate_slug":
      return apiError("validation_error", message, correlationId);
    case "invalid_transition":
    case "gate_failed":
    case "gate_not_passed":
    case "manifest_not_issued":
      return apiError("domain_rule_violation", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};

const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

/** Server-derived ProductionActor from the resolved operator context. */
const toProductionActor = (context: {
  identity: { userId: string };
  organizationId: string;
  roles: readonly ("admin" | "operator" | "reviewer" | "viewer")[];
  capabilities: readonly ControlCapability[];
  correlationId?: string | null;
}): ProductionActor => {
  const member = toMembershipActor(context as never);
  return {
    operatorId: member.operatorId,
    organizationId: member.organizationId,
    roles: member.roles,
    capabilities: member.capabilities,
    ...(member.correlationId === null ? {} : { correlationId: member.correlationId }),
  };
};

export const handleListProjects = async (request: Request) => {
  const auth = await authorizeAdminRequest("production.plan", request);
  if (isAuthError(auth)) return auth.response;
  const projects = await getProductionService().listProjects(toProductionActor(auth.actor as never));
  return apiOk({ projects });
};

export const handleCreateProject = async (request: Request) => {
  const auth = await authorizeAdminRequest("production.plan", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateProjectRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getProductionService().createProject(toProductionActor(auth.actor as never), {
    slug: parsed.data.slug,
    name: parsed.data.name,
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
  });
  return result.ok
    ? apiOk(result.value, 201)
    : productionError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleListProductions = async (request: Request) => {
  const auth = await authorizeAdminRequest("production.plan", request);
  if (isAuthError(auth)) return auth.response;
  const productions = await getProductionService().listProductions(toProductionActor(auth.actor as never));
  return apiOk({ productions });
};

export const handleCreateProduction = async (request: Request) => {
  const auth = await authorizeAdminRequest("production.plan", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateProductionRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getProductionService().createProduction(toProductionActor(auth.actor as never), parsed.data);
  return result.ok
    ? apiOk(result.value, 201)
    : productionError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleGetProduction = async (request: Request, productionId: string) => {
  const auth = await authorizeAdminRequest("production.plan", request);
  if (isAuthError(auth)) return auth.response;
  const result = await getProductionService().getProduction(toProductionActor(auth.actor as never), productionId);
  return result.ok
    ? apiOk(result.value)
    : productionError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleRecordPlanVersion = async (request: Request, productionId: string) => {
  const auth = await authorizeAdminRequest("production.plan", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RecordPlanVersionRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getProductionService().recordPlanVersion(toProductionActor(auth.actor as never), {
    productionId,
    planDocument: parsed.data.planDocument,
  });
  return result.ok
    ? apiOk(result.value, 201)
    : productionError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleSubmitToGate = async (request: Request, productionId: string) => {
  const auth = await authorizeAdminRequest("production.plan", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => ({}));
  const parsed = GateEvaluationRequest.safeParse(body ?? {});
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getProductionService().submitToGate(toProductionActor(auth.actor as never), {
    productionId,
    ...(parsed.data.budgetUsd !== undefined ? { budgetUsd: parsed.data.budgetUsd } : {}),
    ...(parsed.data.moderationPlanned !== undefined ? { moderationPlanned: parsed.data.moderationPlanned } : {}),
  });
  return result.ok
    ? apiOk(result.value)
    : productionError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleRecordGateDecision = async (request: Request, productionId: string) => {
  const auth = await authorizeAdminRequest("production.approve", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = GateDecisionRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getProductionService().recordGateDecision(toProductionActor(auth.actor as never), {
    productionId,
    decision: parsed.data.decision,
  });
  return result.ok
    ? apiOk(result.value)
    : productionError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleIssueManifest = async (request: Request, productionId: string) => {
  const auth = await authorizeAdminRequest("production.approve", request);
  if (isAuthError(auth)) return auth.response;
  const result = await getProductionService().issueManifest(toProductionActor(auth.actor as never), {
    productionId,
  });
  return result.ok
    ? apiOk(result.value, 201)
    : productionError(result.error.reason, result.error.message, auth.correlationId);
};

/** Gate decision body (approve | changes_requested) — local transport schema. */
export const GateDecisionRequest = z.object({
  decision: z.enum(["approve", "changes_requested"]),
});
export type GateDecisionRequest = z.infer<typeof GateDecisionRequest>;
