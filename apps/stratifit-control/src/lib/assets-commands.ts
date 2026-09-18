import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getAssetService } from "./identity";

/**
 * Command handlers for the Stage 2.10 /api/control/assets BFF surface
 * (approved D2.10-3: register + register-version + approve/review, 3 routes).
 *
 * Flow per API_ARCHITECTURE section 11 (Assets card: register, version,
 * approve — capability `production.plan`): resolve operator -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> Zod validation
 * -> asset service -> section 13 error envelope. Handlers are thin; the
 * route files stay adapters. The actor is always server-derived
 * (authorizeAdminRequest -> resolveControlOperator); no client-controlled
 * identity or organization ever reaches the domain service. No client-
 * controlled org_id exists in the request schemas at all.
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map an asset-command error reason to the section 13 error envelope. */
const assetError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "missing_capability":
      return apiError("forbidden", message, correlationId);
    case "asset_not_found":
    case "version_not_found":
    case "parent_not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "invalid_request":
      return apiError("validation_error", message, correlationId);
    case "invalid_transition":
    case "self_edge":
    case "cycle":
    case "duplicate_edge":
      return apiError("domain_rule_violation", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};

const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

/** Server-derived asset actor from the AuthedContext (same shape as 2.6-2.9). */
const assetActorFrom = (auth: AuthedContext) => ({
  operatorId: auth.actor.operatorId,
  organizationId: auth.actor.organizationId,
  roles: auth.actor.roles,
  capabilities: auth.actor.capabilities,
  correlationId: auth.correlationId,
});

// ---- request schemas (route-level validation; the service re-validates) ----

const uuidSchema = z.string().uuid();
const UUID_OR_NULL = uuidSchema.nullish();

const RegisterAssetRequest = z.object({
  kind: z.enum(["video", "audio", "image", "document", "subtitle", "data"]),
  subtype: z
    .enum(["master", "derivative", "thumbnail", "poster", "trailer", "clip", "sample", "subtitle", "lyrics", "caption", "document"])
    .nullish(),
  title: z.string().min(1).max(512),
  description: z.string().max(4096).nullish(),
  productionId: UUID_OR_NULL.optional(),
  shotId: UUID_OR_NULL.optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
});

const StorageRefSchema = z.object({
  bucket: z.string().min(1).max(255),
  storageKey: z.string().min(1).max(1024),
  checksum: z.string().min(1).max(256),
  byteSize: z.number().int().positive(),
  mimeType: z.string().min(1).max(255),
});

const RegisterAssetVersionRequest = z.object({
  assetId: uuidSchema,
  versionNumber: z.number().int().positive().optional(),
  storageRef: StorageRefSchema,
  technicalMetadata: z.record(z.string(), z.unknown()).optional(),
  provenanceGenerationId: UUID_OR_NULL.optional(),
  derivedFrom: z
    .object({
      parentVersionId: uuidSchema,
      derivationKind: z.enum(["generation", "edit", "transcode", "thumbnail", "trailer", "upscale", "enhancement"]),
    })
    .nullish(),
});

const APPROVAL_ACTIONS = ["submit_for_review", "approve", "reject"] as const;

const ApprovalRequest = z.object({
  action: z.enum(APPROVAL_ACTIONS),
  reason: z.string().min(1).max(2048).optional(),
});

// ---- POST /api/control/assets (D2.10-3; capability production.plan) ----

export const handleRegisterAsset = async (request: Request): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.plan" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RegisterAssetRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const d = parsed.data;
  const result = await getAssetService().registerAsset(assetActorFrom(auth), {
    kind: d.kind,
    ...(d.subtype !== undefined ? { subtype: d.subtype } : {}),
    title: d.title,
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.productionId !== undefined ? { productionId: d.productionId } : {}),
    ...(d.shotId !== undefined ? { shotId: d.shotId } : {}),
    ...(d.tags !== undefined ? { tags: d.tags } : {}),
  });
  if (!result.ok) return assetError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ asset: result.value }, 201);
};

// ---- POST /api/control/assets/[id]/versions (D2.10-3; production.plan) ----

export const handleRegisterAssetVersion = async (request: Request, assetId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.plan" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RegisterAssetVersionRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const d = parsed.data;
  // The route parameter IS the asset id; the body assetId (if any) must match.
  if (d.assetId !== assetId) {
    return apiError("validation_error", "assetId in the body must match the route asset id", auth.correlationId);
  }
  const result = await getAssetService().registerAssetVersion(assetActorFrom(auth), {
    assetId,
    ...(d.versionNumber !== undefined ? { versionNumber: d.versionNumber } : {}),
    storageRef: d.storageRef,
    ...(d.technicalMetadata !== undefined ? { technicalMetadata: d.technicalMetadata } : {}),
    ...(d.provenanceGenerationId !== undefined ? { provenanceGenerationId: d.provenanceGenerationId } : {}),
    ...(d.derivedFrom !== undefined ? { derivedFrom: d.derivedFrom } : {}),
  });
  if (!result.ok) return assetError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk(
    {
      version: result.value.version,
      asset: result.value.asset,
      ...(result.value.lineage ? { lineage: result.value.lineage } : {}),
    },
    201,
  );
};

// ---- POST /api/control/assets/[id]/approval (D2.10-3; production.plan) ----

export const handleAssetApproval = async (request: Request, assetId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.plan" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = ApprovalRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const service = getAssetService();
  const actor = assetActorFrom(auth);
  const result =
    parsed.data.action === "submit_for_review"
      ? await service.submitForReview(actor, assetId)
      : parsed.data.action === "approve"
        ? await service.approveAssetVersion(actor, assetId)
        : await service.rejectAssetVersion(actor, assetId, parsed.data.reason ?? "rejected");
  if (!result.ok) return assetError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ asset: result.value });
};
