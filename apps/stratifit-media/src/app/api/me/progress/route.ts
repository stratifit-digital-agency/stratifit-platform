import { NextResponse } from "next/server";
import { z } from "zod";
import { getProgress, toProgressView, upsertProgress } from "@/lib/progress";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * Audience-private watch-progress BFF (Stage 2.14; API_ARCHITECTURE §16.4
 * own-state family). Server-side enforcement:
 *
 *  - Identity is resolved from the authenticated session by services/identity
 *    (public fragment); ANONYMOUS OR NON-AUDIENCE CALLERS ARE REJECTED (401).
 *    An operator session resolves to null audience identity (invariant 12) —
 *    also 401 here.
 *  - The audienceUserId and org are SERVER-DERIVED; the strict request schema
 *    structurally rejects any client userId/audienceUserId/orgId field.
 *  - Responses expose ONLY the whitelisted fields: contentRef (the opaque
 *    public content id), positionSeconds, updatedAt. No production,
 *    publication, asset, generation, QC, or infrastructure identifiers.
 *  - Errors use the §13 envelope: { error: { code, message, correlationId? } }.
 *  - Position must be an integer >= 0 (smaller than the 2^31 guard); content
 *    must exist and be PUBLISHED (published-only eligibility).
 *  - No audit writes (D2.14-2): high-frequency owner state, not an
 *    operator-originated security mutation.
 */

const uuid = z.string().uuid();

const getQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const putBodySchema = z
  .object({
    contentRef: uuid,
    positionSeconds: z.number().int().min(0).max(2_147_483_647),
  })
  .strict();

const errorEnvelope = (code: string, status: number, message: string, fieldErrors?: unknown) =>
  NextResponse.json(
    {
      error: {
        code,
        message,
        ...(fieldErrors ? { fieldErrors } : {}),
      },
    },
    { status },
  );

const unauthorized = () =>
  errorEnvelope("unauthenticated", 401, "Sign in to sync your watch progress.");

/** GET /api/me/progress — owner-scoped list, newest first. */
export async function GET(request: Request) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) return unauthorized();

  const url = new URL(request.url);
  const parsedQuery = getQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsedQuery.success) {
    return errorEnvelope("validation_error", 400, "Invalid query.", parsedQuery.error.flatten().fieldErrors);
  }

  const rows = await getProgress(identity.userId, parsedQuery.data.limit);
  return NextResponse.json({ items: rows.map(toProgressView) });
}

/** PUT /api/me/progress — idempotent per (user, content) upsert. */
export async function PUT(request: Request) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorEnvelope("validation_error", 400, "Body must be valid JSON.");
  }

  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope("validation_error", 400, "Invalid body.", parsed.error.flatten().fieldErrors);
  }

  const result = await upsertProgress(identity.userId, {
    contentRef: parsed.data.contentRef,
    positionSeconds: parsed.data.positionSeconds,
  });

  if (!result.ok) {
    if (result.reason === "user_not_found") {
      return errorEnvelope("user_not_found", 409, "Audience user is not available.");
    }
    return errorEnvelope("content_not_found", 404, "No published content for this contentRef.");
  }

  return NextResponse.json(toProgressView(result.record));
}
