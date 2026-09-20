import { NextResponse } from "next/server";
import {
  beaconSchema,
  buildBeaconInput,
  recordBeacon,
  toBeaconOutcome,
} from "@/lib/analytics";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * PUBLIC ANALYTICS BEACON (Stage 2.19, D2.19-A1..A6).
 *
 * The platform's FIRST intentional public unauthenticated write surface.
 * Security posture:
 *
 *  - Anonymous callers are ACCEPTED (D2.19-A3); an authenticated audience
 *    principal is resolved SERVER-SIDE from the session when present and a
 *    client-supplied audienceUserId is ignored entirely.
 *  - Strict Zod (beaconSchema, .strict()): unknown fields, oversized values,
 *    non-allowlisted property keys, and future-skewed clientTs are rejected.
 *  - Body-size cap 16KB BEFORE parsing (413 payload_too_large).
 *  - Dual-key in-process fixed-window limiter (ip + hashed session) -> 429
 *    rate_limited, retryable: true (D2.19-A5). No Redis/queue/worker.
 *  - contentRef is resolved SERVER-SIDE, published-only; unknown content is
 *    a validation_error (400) with no existence leak beyond the boolean.
 *  - Only the whitelisted 202 outcome is ever returned: { accepted, eventId,
 *    deduped } — never internal row ids, org ids, or limiter internals.
 *
 * §13 envelope on errors: { error: { code, message, correlationId, retryable } }.
 */

const MAX_BODY_BYTES = 16 * 1024;

const errorResponse = (code: string, status: number, message: string, retryable = false) =>
  NextResponse.json(
    { error: { code, message, correlationId: `req_${crypto.randomUUID()}`, retryable } },
    { status },
  );

export async function POST(request: Request) {
  // 1. Size gate BEFORE parsing (DoS guard for the public surface).
  const raw = await request.text();
  if (raw.length>MAX_BODY_BYTES) {
    return errorResponse("payload_too_large", 413, "Beacon body exceeds 16KB.");
  }

  // 2. Parse + strict-validate (400 on malformed or schema-violating bodies).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse("validation_error", 400, "Beacon body is not valid JSON.");
  }
  const schemaResult = beaconSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issue = schemaResult.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid beacon";
    return errorResponse("validation_error", 400, `Invalid beacon — ${where}`);
  }

  // 3. Identity: server-derived when a session exists; anonymous otherwise.
  //    A client-supplied audienceUserId is IGNORED (buildBeaconInput).
  const identity = await resolveMediaIdentity(request).catch(() => null);

  // 4. Intake through the domain service (rate-limit -> resolve -> insert ->
  //    commit -> post-insert analytics.received emission).
  const result = await recordBeacon(buildBeaconInput(schemaResult.data, identity, request));
  if (!result.ok) {
    if (result.error.reason === "rate_limited") {
      return errorResponse("rate_limited", 429, result.error.message, true);
    }
    // content_not_found and any residual intake rejection: validation error.
    return errorResponse("validation_error", 400, result.error.message);
  }

  // 5. Whitelisted 202 — accepted (or idempotent dedupe replay).
  return NextResponse.json(toBeaconOutcome(result.value.outcome), { status: 202 });
}
