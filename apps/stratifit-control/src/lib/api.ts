import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * API_ARCHITECTURE section 13 error envelope for the Control API.
 *
 *   { error: { code, message, correlationId, fieldErrors?, retryable } }
 *
 * Secrets, stack traces, and infrastructure internals are never exposed.
 * Every error carries a correlationId (section 22); `retryable` guides client
 * retry behavior.
 */

export type ApiErrorCode =
  | "validation_error"
  | "unauthenticated"
  | "forbidden"
  | "email_verification_required"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "domain_rule_violation"
  | "dependency_failure"
  | "internal_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  validation_error: 400,
  unauthenticated: 401,
  forbidden: 403,
  email_verification_required: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  domain_rule_violation: 422,
  dependency_failure: 503,
  internal_error: 500,
};

export interface ApiErrorOptions {
  status?: number;
  fieldErrors?: { field: string; message: string }[];
  retryable?: boolean;
}

export const newCorrelationId = (): string => `req_${randomUUID()}`;

export const apiError = (
  code: ApiErrorCode,
  message: string,
  correlationId: string,
  options: ApiErrorOptions = {},
): NextResponse =>
  NextResponse.json(
    {
      error: {
        code,
        message,
        correlationId,
        ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
        retryable: options.retryable ?? false,
      },
    },
    { status: options.status ?? STATUS_BY_CODE[code] },
  );

export const apiOk = <T>(data: T, status = 200): NextResponse =>
  NextResponse.json(data as object, { status });

/** Classified mapping of membership command errors to section 13 codes. */
export const membershipError = (
  reason: string,
  message: string,
  correlationId: string,
): NextResponse => {
  switch (reason) {
    case "missing_capability":
    case "self_grant":
    case "role_escalation":
      return apiError("forbidden", message, correlationId);
    case "cross_org":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "invalid_request":
      return apiError("validation_error", message, correlationId);
    case "membership_conflict":
      return apiError("conflict", message, correlationId);
    case "invalid_transition":
    case "org_not_active":
    case "team_not_active":
    case "operator_not_active":
      return apiError("domain_rule_violation", message, correlationId);
    case "operator_not_found":
    case "membership_not_found":
    case "team_not_found":
      return apiError("not_found", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};
