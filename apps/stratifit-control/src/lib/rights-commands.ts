import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getRightsService } from "./identity";

/**
 * Command handlers for the Stage 2.21 /api/control/rights BFF surface
 * (D2.21-4: dedicated rights.* capability family — never production.* or
 * creative.*; D2.21-2: the evaluator is NOT wired into any approval/authoring
 * flow — these routes manage owners/grants and expose the status-event
 * history).
 *
 * Flow per API_ARCHITECTURE section 11: resolve operator -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> Zod validation
 * -> Rights service -> section 13 error envelope. The actor is always
 * server-derived; no client-controlled identity or organization ever reaches
 * the domain service, and every request schema contains NO client org/
 * authority field (strict Zod — unknown fields rejected).
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a Rights-command error reason to the section 13 error envelope. */
const rightsError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "unauthorized":
      return apiError("forbidden", message, correlationId);
    case "not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "cross_org_reference":
      return apiError("not_found", "referenced aggregate does not exist", correlationId);
    case "invalid_input":
      return apiError("validation_error", message, correlationId);
    case "inactive_parent":
    case "invalid_status_transition":
      return apiError("domain_rule_violation", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};

const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

// ---------------------------------------------------------------------------
// Strict request schemas (no client org/identity authority anywhere)
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

export const CreateOwnerRequest = z
  .object({
    kind: z.enum(["individual", "organization"]),
    displayName: z.string().min(1).max(200),
    contactRef: z.string().max(500).nullish(),
  })
  .strict();

export const OwnerVerificationRequest = z
  .object({
    status: z.enum(["unverified", "pending", "verified", "rejected"]),
  })
  .strict();

export const CreateGrantRequest = z
  .object({
    ownerId: uuid,
    subjectKind: z.enum(["digital_human", "character", "persona", "asset", "production"]),
    subjectId: uuid,
    scope: z.enum(["generation", "publication", "advertising", "messaging", "derivative_creation"]),
    platforms: z.array(z.enum(["stratifit_media", "youtube", "tiktok", "instagram", "facebook", "all"])).min(1).max(6),
    territories: z.array(z.string().regex(/^worldwide$|^[A-Z]{2}$/)).min(1).max(50),
    startsAt: z.string().datetime({ offset: true }).nullish(),
    expiresAt: z.string().datetime({ offset: true }).nullish(),
    evidenceRefs: z.array(z.string().min(1).max(500)).max(20).optional(),
  })
  .strict();

export const GrantStatusRequest = z
  .object({
    // D2.21-5 lifecycle; the service enforces the frozen transition table.
    status: z.enum(["active", "suspended", "revoked", "expired"]),
    reason: z.string().max(1000).nullish(),
  })
  .strict();

// Stage 2.22 (D2.22-1/-3): requirements declarations.
export const CreateRequirementRequest = z
  .object({
    subjectKind: z.enum(["digital_human", "character", "persona", "asset", "production"]),
    subjectId: uuid,
    scope: z.enum(["generation", "publication", "advertising", "messaging", "derivative_creation"]),
    platforms: z.array(z.enum(["stratifit_media", "youtube", "tiktok", "instagram", "facebook", "all"])).min(1).max(6),
    territories: z.array(z.string().regex(/^worldwide$|^[A-Z]{2}$/)).min(1).max(50),
    enforcement: z.enum(["enforce", "record_only"]),
    reason: z.string().max(1000).nullish(),
  })
  .strict();

export const UpdateRequirementRequest = z
  .object({
    platforms: z.array(z.enum(["stratifit_media", "youtube", "tiktok", "instagram", "facebook", "all"])).min(1).max(6).optional(),
    territories: z.array(z.string().regex(/^worldwide$|^[A-Z]{2}$/)).min(1).max(50).optional(),
    enforcement: z.enum(["enforce", "record_only"]).optional(),
    reason: z.string().max(1000).nullish(),
  })
  .strict();

const LIMIT_QUERY = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();

const rightsPrincipal = (auth: AuthedContext) => ({
  operatorId: auth.actor.operatorId,
  orgId: auth.actor.organizationId,
  capabilities: auth.actor.capabilities,
});

// ---------------------------------------------------------------------------
// Authoring handlers (rights.manage)
// ---------------------------------------------------------------------------

export const handleCreateOwner = async (request: Request) => {
  const auth = await authorizeAdminRequest("rights.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateOwnerRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getRightsService().createOwner(rightsPrincipal(auth), {
    kind: parsed.data.kind,
    displayName: parsed.data.displayName,
    contactRef: parsed.data.contactRef ?? null,
  });
  return result.ok ? apiOk(result.value, 201) : rightsError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleOwnerVerification = async (request: Request, id: string) => {
  const auth = await authorizeAdminRequest("rights.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = OwnerVerificationRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getRightsService().changeOwnerVerification(rightsPrincipal(auth), {
    id,
    status: parsed.data.status,
  });
  return result.ok ? apiOk(result.value) : rightsError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleCreateGrant = async (request: Request) => {
  const auth = await authorizeAdminRequest("rights.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateGrantRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getRightsService().createGrant(rightsPrincipal(auth), {
    ownerId: parsed.data.ownerId,
    subjectKind: parsed.data.subjectKind,
    subjectId: parsed.data.subjectId,
    scope: parsed.data.scope,
    platforms: parsed.data.platforms,
    territories: parsed.data.territories,
    startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    evidenceRefs: parsed.data.evidenceRefs ?? [],
  });
  return result.ok ? apiOk(result.value, 201) : rightsError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleGrantStatus = async (request: Request, id: string) => {
  const auth = await authorizeAdminRequest("rights.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = GrantStatusRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getRightsService().changeGrantStatus(rightsPrincipal(auth), {
    id,
    status: parsed.data.status,
    reason: parsed.data.reason ?? null,
  });
  return result.ok ? apiOk(result.value) : rightsError(result.error.reason, result.error.message, auth.correlationId);
};

// ---------------------------------------------------------------------------
// Requirements handlers (Stage 2.22, D2.22-1/-3/-6)
// ---------------------------------------------------------------------------

export const handleCreateRequirement = async (request: Request) => {
  const auth = await authorizeAdminRequest("rights.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateRequirementRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getRightsService().createRequirement(rightsPrincipal(auth), {
    subjectKind: parsed.data.subjectKind,
    subjectId: parsed.data.subjectId,
    scope: parsed.data.scope,
    platforms: parsed.data.platforms,
    territories: parsed.data.territories,
    enforcement: parsed.data.enforcement,
    reason: parsed.data.reason ?? null,
  });
  return result.ok ? apiOk(result.value, 201) : rightsError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleUpdateRequirement = async (request: Request, id: string) => {
  const auth = await authorizeAdminRequest("rights.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = UpdateRequirementRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getRightsService().updateRequirement(rightsPrincipal(auth), {
    id,
    ...(parsed.data.platforms !== undefined ? { platforms: parsed.data.platforms } : {}),
    ...(parsed.data.territories !== undefined ? { territories: parsed.data.territories } : {}),
    ...(parsed.data.enforcement !== undefined ? { enforcement: parsed.data.enforcement } : {}),
    ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason ?? null } : {}),
  });
  return result.ok ? apiOk(result.value) : rightsError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleDeleteRequirement = async (request: Request, id: string) => {
  const auth = await authorizeAdminRequest("rights.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const result = await getRightsService().deleteRequirement(rightsPrincipal(auth), id);
  return result.ok ? apiOk(result.value) : rightsError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleListRequirements = async (request: Request) => {
  const auth = await authorizeAdminRequest("rights.read" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const query = LIMIT_QUERY.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return validationFrom(query.error.issues, auth.correlationId);
  const result = await getRightsService().listRequirements(rightsPrincipal(auth), query.data.limit);
  if (!result.ok) return rightsError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ items: result.value });
};

// ---------------------------------------------------------------------------
// Read handlers (rights.read)
// ---------------------------------------------------------------------------

export const handleListOwners = async (request: Request) => {
  const auth = await authorizeAdminRequest("rights.read" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const query = LIMIT_QUERY.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return validationFrom(query.error.issues, auth.correlationId);
  const result = await getRightsService().listOwners(rightsPrincipal(auth), query.data.limit);
  if (!result.ok) return rightsError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ items: result.value });
};

export const handleListGrants = async (request: Request) => {
  const auth = await authorizeAdminRequest("rights.read" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const query = LIMIT_QUERY.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return validationFrom(query.error.issues, auth.correlationId);
  const result = await getRightsService().listGrants(rightsPrincipal(auth), query.data.limit);
  if (!result.ok) return rightsError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ items: result.value });
};

/** GET grant detail — includes the immutable status-event history (D2.21-3). */
export const handleGetGrant = async (request: Request, id: string) => {
  const auth = await authorizeAdminRequest("rights.read" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const result = await getRightsService().getGrant(rightsPrincipal(auth), id);
  if (!result.ok) return rightsError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ grant: result.value.grant, statusEvents: result.value.history });
};
