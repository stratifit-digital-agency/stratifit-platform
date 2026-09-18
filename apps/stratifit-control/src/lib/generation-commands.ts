import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getGenerationService } from "./identity";

/**
 * Command handlers for the Stage 2.9 /api/control/generations BFF surface
 * (approved D2.9-3: POST request + GET provenance read; 2 routes).
 *
 * Flow per API_ARCHITECTURE section 11 (generation card): resolve operator
 * -> 401 `unauthenticated` -> capability check (`generation.request`) ->
 * 403 `forbidden` -> Zod validation -> generation service -> section 13
 * error envelope. Handlers are thin; the route files stay adapters. The
 * actor is always server-derived (authorizeAdminRequest ->
 * resolveControlOperator); no client-controlled identity or organization
 * ever reaches the domain service. No client-controlled org_id exists in
 * the request schemas at all.
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a generation-command error reason to the section 13 error envelope. */
const generationError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "missing_capability":
      return apiError("forbidden", message, correlationId);
    case "cross_org":
    case "generation_not_found":
    case "parent_not_found":
    case "model_not_found":
    case "workflow_not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "model_disabled":
    case "workflow_disabled":
      return apiError("domain_rule_violation", message, correlationId);
    case "invalid_request":
      return apiError("validation_error", message, correlationId);
    case "invalid_transition":
    case "completion_conflict":
      return apiError("domain_rule_violation", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};

const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

/** Server-derived generation actor from the AuthedContext (same shape as 2.6/2.8). */
const generationActorFrom = (auth: AuthedContext) => ({
  operatorId: auth.actor.operatorId,
  organizationId: auth.actor.organizationId,
  roles: auth.actor.roles,
  capabilities: auth.actor.capabilities,
  correlationId: auth.correlationId,
});

// ---- request schemas (route-level validation; the service re-validates) ----

const uuidSchema = z.string().uuid();

const UUID_OR_NULL = uuidSchema.nullish();

const RequestGenerationRequest = z.object({
  modelId: uuidSchema,
  modelVersion: z.string().min(1).max(128),
  workflowId: UUID_OR_NULL.optional(),
  workflowVersion: z.string().max(128).nullish(),
  parentGenerationId: UUID_OR_NULL.optional(),
  productionId: UUID_OR_NULL.optional(),
  sceneId: UUID_OR_NULL.optional(),
  shotId: UUID_OR_NULL.optional(),
  inputAssetVersionIds: z.array(uuidSchema).max(64).optional(),
  prompt: z.string().min(1).max(8192),
  negativePrompt: z.string().max(8192).nullish(),
  seed: z.string().max(128).nullish(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  resolution: z.string().max(64).nullish(),
  fps: z.number().int().positive().nullish(),
  durationSeconds: z.string().max(32).nullish(),
  adapters: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
  estimatedCostUsd: z.string().max(32).nullish(),
  requestKey: z.string().min(1).max(512).nullish(),
});

// ---- POST /api/control/generations (D2.9-3; capability generation.request) ----

export const handleRequestGeneration = async (request: Request): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("generation.request" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RequestGenerationRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const d = parsed.data;
  const result = await getGenerationService().requestGeneration(generationActorFrom(auth), {
    modelId: d.modelId,
    modelVersion: d.modelVersion,
    ...(d.workflowId !== undefined ? { workflowId: d.workflowId } : {}),
    ...(d.workflowVersion !== undefined ? { workflowVersion: d.workflowVersion } : {}),
    ...(d.parentGenerationId !== undefined ? { parentGenerationId: d.parentGenerationId } : {}),
    ...(d.productionId !== undefined ? { productionId: d.productionId } : {}),
    ...(d.sceneId !== undefined ? { sceneId: d.sceneId } : {}),
    ...(d.shotId !== undefined ? { shotId: d.shotId } : {}),
    ...(d.inputAssetVersionIds !== undefined ? { inputAssetVersionIds: d.inputAssetVersionIds } : {}),
    prompt: d.prompt,
    ...(d.negativePrompt !== undefined ? { negativePrompt: d.negativePrompt } : {}),
    ...(d.seed !== undefined ? { seed: d.seed } : {}),
    ...(d.parameters !== undefined ? { parameters: d.parameters } : {}),
    ...(d.resolution !== undefined ? { resolution: d.resolution } : {}),
    ...(d.fps !== undefined ? { fps: d.fps } : {}),
    ...(d.durationSeconds !== undefined ? { durationSeconds: d.durationSeconds } : {}),
    ...(d.adapters !== undefined ? { adapters: d.adapters } : {}),
    ...(d.estimatedCostUsd !== undefined ? { estimatedCostUsd: d.estimatedCostUsd } : {}),
    ...(d.requestKey !== undefined ? { requestKey: d.requestKey } : {}),
  });
  if (!result.ok) return generationError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk(
    { generation: result.value.generation, deduplicated: result.value.deduplicated },
    result.value.deduplicated ? 200 : 201,
  );
};

// ---- GET /api/control/generations/[id] (provenance read; API_ARCHITECTURE §7.283) ----

export const handleGetGeneration = async (request: Request, generationId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("generation.request" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generationId)) {
    return apiError("validation_error", "generation id must be a UUID", auth.correlationId);
  }
  const result = await getGenerationService().getProvenance(generationActorFrom(auth), generationId);
  if (!result.ok) {
    // No provenance yet ≠ absent generation: return the generation alone.
    if (result.error.reason === "generation_not_found") {
      const gen = await getGenerationService().getGeneration(generationActorFrom(auth), generationId);
      if (!gen.ok) return generationError(gen.error.reason, gen.error.message, auth.correlationId);
      return apiOk({ generation: gen.value, provenance: null });
    }
    return generationError(result.error.reason, result.error.message, auth.correlationId);
  }
  return apiOk({ generation: result.value.generation, provenance: result.value.provenance });
};
