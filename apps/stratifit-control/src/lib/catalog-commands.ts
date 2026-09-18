import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getCatalogService, getWorkflowCatalogService } from "./identity";

/**
 * Command handlers for the Stage 2.8 /api/control/{models,workflows} BFF
 * surface (approved D2.8-1, 6 route files / 8 operations).
 *
 * Flow per API_ARCHITECTURE section 11: resolveControlOperator() -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> owning package
 * (packages/ai / packages/workflows catalog services) -> section 13 error
 * envelope. Handlers are thin; the HTTP route files stay adapters. No domain
 * business logic lives here. The actor is always server-derived
 * (authorizeAdminRequest -> resolveControlOperator); no client-controlled
 * identity or organization ever reaches the domain services.
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a catalog-command error reason to the section 13 error envelope. */
const catalogError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "missing_capability":
      return apiError("forbidden", message, correlationId);
    case "cross_org":
    case "model_not_found":
    case "workflow_not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "invalid_request":
      return apiError("validation_error", message, correlationId);
    case "duplicate_name":
    case "duplicate_version":
      return apiError("conflict", message, correlationId);
    case "invalid_transition":
      return apiError("domain_rule_violation", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};

const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

/** Server-derived catalog actor from the AuthedContext (same shape as 2.6). */
const toCatalogActor = (context: {
  identity: { userId: string };
  organizationId: string;
  roles: readonly ("admin" | "operator" | "reviewer" | "viewer")[];
  capabilities: readonly ControlCapability[];
}) => ({
  operatorId: context.identity.userId,
  organizationId: context.organizationId,
  roles: context.roles,
  capabilities: context.capabilities,
});

/** Bridge: the AuthedContext actor (MembershipActor) carries operatorId +
 *  organizationId + server-derived roles/capabilities; the catalog actor is
 *  the same context without correlationId plumbing (audit derives it from the
 *  request header inside the services via the composition root writer). */
const catalogActorFrom = (auth: AuthedContext) =>
  toCatalogActor({
    identity: { userId: auth.actor.operatorId },
    organizationId: auth.actor.organizationId,
    roles: auth.actor.roles,
    capabilities: auth.actor.capabilities,
  });

// ---- request schemas (route-level validation; the service re-validates) ----

const CAPABILITY_KIND_SCHEMA = z.enum([
  "image.generation",
  "video.generation",
  "voice.synthesis",
  "music.generation",
  "audio",
  "lip.sync",
  "sfx",
  "vfx",
  "enhancement",
]);

const RegisterModelRequest = z.object({
  name: z.string().min(1).max(200),
  capabilityKind: CAPABILITY_KIND_SCHEMA,
  displayName: z.string().max(200).optional(),
  vendorLabel: z.string().max(200).optional(),
});

const RegisterModelVersionRequest = z.object({
  version: z.string().min(1).max(128),
  adapterRef: z.string().min(1).max(200),
  compatibility: z.record(z.string(), z.unknown()).optional(),
  defaultParameters: z.record(z.string(), z.unknown()).optional(),
});

const UpdateStatusRequest = z.object({
  status: z.enum(["active", "deprecated", "disabled"]),
});

const RegisterWorkflowRequest = z.object({
  name: z.string().min(1).max(200),
  supports: z.array(CAPABILITY_KIND_SCHEMA),
});

const RegisterWorkflowVersionRequest = z.object({
  version: z.string().min(1).max(128),
  runtimeRef: z.string().min(1).max(200),
  definition: z.record(z.string(), z.unknown()).optional(),
  compatibility: z.record(z.string(), z.unknown()).optional(),
});

// ---- models ----

export const handleListModels = async (request: Request): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("model.manage", request);
  if (isAuthError(auth)) return auth.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const capabilityKind = url.searchParams.get("capabilityKind");
  const models = await getCatalogService().listModels(catalogActorFrom(auth), {
    ...(status ? { status: status as "active" | "deprecated" | "disabled" } : {}),
    ...(capabilityKind ? { capabilityKind } : {}),
  });
  return apiOk({ models });
};

export const handleCreateModel = async (request: Request): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("model.manage", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RegisterModelRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getCatalogService().registerModel(catalogActorFrom(auth), {
    name: parsed.data.name,
    capabilityKind: parsed.data.capabilityKind,
    displayName: parsed.data.displayName ?? parsed.data.name,
    vendorLabel: parsed.data.vendorLabel ?? "unknown",
  });
  if (!result.ok) return catalogError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ model: result.value }, 201);
};

export const handleCreateModelVersion = async (request: Request, modelId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("model.manage", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RegisterModelVersionRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getCatalogService().registerModelVersion(catalogActorFrom(auth), {
    modelId,
    version: parsed.data.version,
    adapterRef: parsed.data.adapterRef,
    ...(parsed.data.compatibility !== undefined ? { compatibility: parsed.data.compatibility } : {}),
    ...(parsed.data.defaultParameters !== undefined ? { defaultParameters: parsed.data.defaultParameters } : {}),
  });
  if (!result.ok) return catalogError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ modelVersion: result.value }, 201);
};

export const handleUpdateModelStatus = async (request: Request, modelId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("model.manage", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = UpdateStatusRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getCatalogService().updateModelStatus(catalogActorFrom(auth), {
    modelId,
    status: parsed.data.status,
  });
  if (!result.ok) return catalogError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ model: result.value });
};

// ---- workflows ----

export const handleListWorkflows = async (request: Request): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("workflow.manage", request);
  if (isAuthError(auth)) return auth.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const workflows = await getWorkflowCatalogService().listWorkflows(catalogActorFrom(auth), {
    ...(status ? { status: status as "active" | "deprecated" | "disabled" } : {}),
  });
  return apiOk({ workflows });
};

export const handleCreateWorkflow = async (request: Request): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("workflow.manage", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RegisterWorkflowRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getWorkflowCatalogService().registerWorkflow(catalogActorFrom(auth), {
    name: parsed.data.name,
    supports: parsed.data.supports,
  });
  if (!result.ok) return catalogError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ workflow: result.value }, 201);
};

export const handleCreateWorkflowVersion = async (request: Request, workflowId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("workflow.manage", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RegisterWorkflowVersionRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getWorkflowCatalogService().registerWorkflowVersion(catalogActorFrom(auth), {
    workflowId,
    version: parsed.data.version,
    runtimeRef: parsed.data.runtimeRef,
    ...(parsed.data.definition !== undefined ? { definition: parsed.data.definition } : {}),
    ...(parsed.data.compatibility !== undefined ? { compatibility: parsed.data.compatibility } : {}),
  });
  if (!result.ok) return catalogError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ workflowVersion: result.value }, 201);
};

export const handleUpdateWorkflowStatus = async (request: Request, workflowId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("workflow.manage", request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = UpdateStatusRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getWorkflowCatalogService().updateWorkflowStatus(catalogActorFrom(auth), {
    workflowId,
    status: parsed.data.status,
  });
  if (!result.ok) return catalogError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ workflow: result.value });
};
