import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getPublishingService } from "./identity";

/**
 * Command handlers for the Stage 2.12 /api/control/publications BFF surface
 * (plan section 15: exactly 8 routes — POST create, submit, approve,
 * schedule, publish, unpublish, revise, GET read).
 *
 * Flow per API_ARCHITECTURE section 11 (Publishing card: create/approve/
 * publish, capability `production.publish`, D2.12-G — no new permission):
 * resolve operator -> 401 `unauthenticated` -> capability check -> 403
 * `forbidden` -> Zod validation -> publishing service -> section 13 error
 * envelope. Handlers are thin; the route files stay adapters. The actor is
 * always server-derived (authorizeAdminRequest -> resolveControlOperator);
 * no client-controlled identity or organization ever reaches the domain
 * service, and the request schemas contain NO client org_id at all.
 *
 * FAILURE ISOLATION: publish/unpublish handlers touch ONLY publishing state.
 * There is no route or handler that mutates asset approval, generation, or
 * production state (DM invariant 5).
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a publishing-command error reason to the section 13 error envelope. */
const publishingError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "missing_capability":
      return apiError("forbidden", message, correlationId);
    case "publication_not_found":
    case "subject_not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "subject_unsupported":
      // ai_creator_profile / campaign_creative fail closed (D2.12-D).
      return apiError("domain_rule_violation", message, correlationId);
    case "publication_conflict":
      // FROZEN duplicate-create behavior: deterministic 409 conflict — the
      // UNIQUE(org, subject, platform) constraint remains the backstop.
      return apiError("conflict", message, correlationId);
    case "invalid_request":
      return apiError("validation_error", message, correlationId);
    case "invalid_transition":
    case "gate_not_approved":
    case "rights_requirements_unmet":
    case "max_attempts_exhausted":
      return apiError("domain_rule_violation", message, correlationId);
    case "adapter_not_found":
      return apiError("internal_error", message, correlationId);
    case "conflict":
      return apiError("domain_rule_violation", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};

const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

/** Server-derived publishing actor from the AuthedContext (same as 2.11). */
const publishingActorFrom = (auth: AuthedContext) => ({
  operatorId: auth.actor.operatorId,
  organizationId: auth.actor.organizationId,
  roles: auth.actor.roles,
  capabilities: auth.actor.capabilities,
  correlationId: auth.correlationId,
});

const uuidSchema = z.string().uuid();

const SUBJECT_KINDS = ["production", "asset_version", "ai_creator_profile", "campaign_creative"] as const;
const PLATFORM_TARGETS = ["stratifit-media", "youtube", "tiktok", "instagram", "facebook"] as const;
const CONTENT_TYPES = ["film", "series", "episode", "short", "music", "documentary", "trailer"] as const;

const CreatePublicationRequest = z.object({
  subjectKind: z.enum(SUBJECT_KINDS),
  subjectRef: uuidSchema,
  platformTarget: z.enum(PLATFORM_TARGETS),
  contentType: z.enum(CONTENT_TYPES),
  title: z.string().min(1).max(512),
  synopsis: z.string().max(4096).optional(),
});

const SchedulePublicationRequest = z.object({
  scheduledFor: z.string().datetime(),
});

const RevisePublicationRequest = z.object({
  title: z.string().min(1).max(512).optional(),
  synopsis: z.string().max(4096).optional(),
});

// ---- POST /api/control/publications (201 create / 200 dedupe) ----

export const handleCreatePublication = async (request: Request): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.publish" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreatePublicationRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getPublishingService().createPublication(publishingActorFrom(auth), {
    subjectKind: parsed.data.subjectKind,
    subjectRef: parsed.data.subjectRef,
    platformTarget: parsed.data.platformTarget,
    contentType: parsed.data.contentType,
    title: parsed.data.title,
    ...(parsed.data.synopsis !== undefined ? { synopsis: parsed.data.synopsis } : {}),
  });
  if (!result.ok) return publishingError(result.error.reason, result.error.message, auth.correlationId);
  // FROZEN: creates are ALWAYS 201; duplicates are a deterministic 409
  // publication_conflict (no 200-deduplication path exists).
  return apiOk({ publication: result.value.publication, version: result.value.version }, 201);
};

// ---- POST /api/control/publications/[id]/submit ----

export const handlePublishingSubmit = async (request: Request, publicationId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.publish" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(publicationId).success) {
    return apiError("validation_error", "publication id must be a UUID", auth.correlationId);
  }
  const result = await getPublishingService().submit(publishingActorFrom(auth), publicationId);
  if (!result.ok) return publishingError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ publication: result.value });
};

// ---- POST /api/control/publications/[id]/approve ----

export const handlePublishingApprove = async (request: Request, publicationId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.publish" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(publicationId).success) {
    return apiError("validation_error", "publication id must be a UUID", auth.correlationId);
  }
  const result = await getPublishingService().approve(publishingActorFrom(auth), publicationId);
  if (!result.ok) return publishingError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ publication: result.value });
};

// ---- POST /api/control/publications/[id]/schedule ----

export const handlePublishingSchedule = async (request: Request, publicationId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.publish" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(publicationId).success) {
    return apiError("validation_error", "publication id must be a UUID", auth.correlationId);
  }
  const body = await request.json().catch(() => null);
  const parsed = SchedulePublicationRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getPublishingService().schedule(publishingActorFrom(auth), publicationId, {
    scheduledFor: parsed.data.scheduledFor,
  });
  if (!result.ok) return publishingError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ publication: result.value });
};

// ---- POST /api/control/publications/[id]/publish (ONLY from scheduled) ----

export const handlePublishingPublish = async (request: Request, publicationId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.publish" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(publicationId).success) {
    return apiError("validation_error", "publication id must be a UUID", auth.correlationId);
  }
  const result = await getPublishingService().publish(publishingActorFrom(auth), publicationId);
  if (!result.ok) return publishingError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ publication: result.value.publication, distributionReference: result.value.reference });
};

// ---- POST /api/control/publications/[id]/unpublish ----

export const handlePublishingUnpublish = async (request: Request, publicationId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.publish" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(publicationId).success) {
    return apiError("validation_error", "publication id must be a UUID", auth.correlationId);
  }
  const result = await getPublishingService().unpublish(publishingActorFrom(auth), publicationId);
  if (!result.ok) return publishingError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ publication: result.value });
};

// ---- POST /api/control/publications/[id]/revise (draft-only, version N+1) ----

export const handlePublishingRevise = async (request: Request, publicationId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.publish" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(publicationId).success) {
    return apiError("validation_error", "publication id must be a UUID", auth.correlationId);
  }
  const body = await request.json().catch(() => null);
  const parsed = RevisePublicationRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getPublishingService().revise(publishingActorFrom(auth), publicationId, {
    ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
    ...(parsed.data.synopsis !== undefined ? { synopsis: parsed.data.synopsis } : {}),
  });
  if (!result.ok) return publishingError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ version: result.value });
};

// ---- GET /api/control/publications/[id] (publication + versions + references) ----

export const handleGetPublication = async (request: Request, publicationId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.publish" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(publicationId).success) {
    return apiError("validation_error", "publication id must be a UUID", auth.correlationId);
  }
  const result = await getPublishingService().getPublication(publishingActorFrom(auth), publicationId);
  if (!result.ok) return publishingError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk(result.value);
};
