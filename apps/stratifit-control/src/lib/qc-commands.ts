import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getQcService } from "./identity";

/**
 * Command handlers for the Stage 2.11 /api/control/qc BFF surface (approved
 * D2.11-5: exactly 3 routes — POST review request, POST decision, GET read).
 *
 * Flow per API_ARCHITECTURE section 11 (QC card: "request review, record
 * decisions", capability `production.approve`): resolve operator -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> Zod validation
 * -> QC service -> section 13 error envelope. Handlers are thin; the route
 * files stay adapters. The actor is always server-derived
 * (authorizeAdminRequest -> resolveControlOperator); no client-controlled
 * identity or organization ever reaches the domain service, and the request
 * schemas contain NO client org_id at all.
 *
 * HARD domain-separation rule: these handlers expose QC review state ONLY.
 * There is no route, handler, or service path that mutates asset approval
 * state from QC.
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a QC-command error reason to the section 13 error envelope. */
const qcError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "missing_capability":
      return apiError("forbidden", message, correlationId);
    case "review_not_found":
    case "check_not_found":
    case "subject_not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "subject_unsupported":
      // Publication subjects fail closed until durable Publishing exists.
      return apiError("domain_rule_violation", message, correlationId);
    case "check_archived":
      return apiError("domain_rule_violation", message, correlationId);
    case "invalid_request":
      return apiError("validation_error", message, correlationId);
    case "invalid_transition":
    case "decision_conflict":
    case "resolution_conflict":
      return apiError("domain_rule_violation", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};

const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

/** Server-derived QC actor from the AuthedContext (same shape as 2.9/2.10). */
const qcActorFrom = (auth: AuthedContext) => ({
  operatorId: auth.actor.operatorId,
  organizationId: auth.actor.organizationId,
  roles: auth.actor.roles,
  capabilities: auth.actor.capabilities,
  correlationId: auth.correlationId,
});

const uuidSchema = z.string().uuid();

const SUBJECT_KINDS = ["asset_version", "generation", "production", "publication"] as const;

const RequestReviewRequest = z.object({
  subjectKind: z.enum(SUBJECT_KINDS),
  subjectRef: uuidSchema,
});

const DecisionRequest = z.object({
  decision: z.enum(["approve", "reject", "changes_requested"]),
  reason: z.string().max(2048).nullish(),
});

// ---- POST /api/control/qc/reviews (D2.11-5; capability production.approve) ----

export const handleRequestQcReview = async (request: Request): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.approve" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = RequestReviewRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getQcService().requestReview(qcActorFrom(auth), {
    subjectKind: parsed.data.subjectKind,
    subjectRef: parsed.data.subjectRef,
  });
  if (!result.ok) return qcError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk(
    { review: result.value.review, deduplicated: result.value.deduplicated },
    result.value.deduplicated ? 200 : 201,
  );
};

// ---- POST /api/control/qc/reviews/[id]/decision ----

export const handleRecordQcDecision = async (request: Request, reviewId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.approve" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(reviewId).success) {
    return apiError("validation_error", "review id must be a UUID", auth.correlationId);
  }
  const body = await request.json().catch(() => null);
  const parsed = DecisionRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getQcService().recordDecision(qcActorFrom(auth), reviewId, {
    decision: parsed.data.decision,
    ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
  });
  if (!result.ok) return qcError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ review: result.value.review, decision: result.value.decision });
};

// ---- GET /api/control/qc/reviews/[id] (read: review + results + decisions + issues) ----

export const handleGetQcReview = async (request: Request, reviewId: string): Promise<NextResponse> => {
  const auth = await authorizeAdminRequest("production.approve" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  if (!uuidSchema.safeParse(reviewId).success) {
    return apiError("validation_error", "review id must be a UUID", auth.correlationId);
  }
  const result = await getQcService().getReview(qcActorFrom(auth), reviewId);
  if (!result.ok) return qcError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk(result.value);
};
