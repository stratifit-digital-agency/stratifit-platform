import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveMediaIdentity } from "./identity";
import { principalOf, type SocialWriteOutcome } from "./social";

/**
 * Shared plumbing for the social BFF routes (Stage 2.15). Mirrors the
 * Stage 2.14 progress route conventions exactly:
 *
 *  - Identity is resolved from the authenticated session server-side;
 *    ANONYMOUS OR NON-AUDIENCE CALLERS ARE REJECTED (401) — an operator
 *    session resolves to null audience identity (invariant 12).
 *  - userId/emailVerified/org are SERVER-DERIVED; strict Zod schemas
 *    structurally reject any client userId/audienceUserId/orgId field.
 *  - §13 error envelope: { error: { code, message, fieldErrors? } }.
 *  - Responses expose whitelisted fields only.
 */
export const uuid = z.string().uuid();

/** D2.16-8: creator handle shape — mirrors the DB CHECK ^[a-z0-9-]{3,64}$. */
export const handleShape = z.string().regex(/^[a-z0-9-]{3,64}$/);

export const errorEnvelope = (code: string, status: number, message: string, fieldErrors?: unknown) =>
  NextResponse.json(
    { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } },
    { status },
  );

export const unauthorized = () =>
  errorEnvelope("unauthenticated", 401, "Sign in to use social features.");

export const unauthorizedVerified = () =>
  errorEnvelope("email_verification_required", 403, "Verify your email to use this feature.");

/** Resolve the server-derived principal; null keeps the caller anonymous. */
export const requirePrincipal = async (request: Request) => {
  const identity = await resolveMediaIdentity(request);
  if (!identity) return null;
  return principalOf(identity);
};

/** Map a social write outcome to its HTTP response. */
export const writeResponse = (outcome: SocialWriteOutcome, successStatus = 200) => {
  if (outcome.ok) return NextResponse.json({ status: outcome.state }, { status: successStatus });
  const statusByReason: Record<string, number> = {
    unauthenticated: 401,
    email_verification_required: 403,
    content_not_found: 404,
    user_not_found: 401,
    self_follow: 422,
    creator_targets_unsupported: 422,
    invalid_channel: 400,
    invalid_body: 400,
    parent_not_found: 404,
  };
  return errorEnvelope(outcome.reason, statusByReason[outcome.reason] ?? 400, outcome.message);
};

/** Strict toggle body: contentRef only — any extra (authority) field rejected. */
export const toggleBodySchema = z.object({ contentRef: uuid }).strict();

/** Strict follow body. */
/** D2.16-5: optional kind selector — audience_user (default) | creator_profile. */
export const followBodySchema = z
  .object({
    followeeRef: uuid,
    followeeKind: z.enum(["audience_user", "creator_profile"]).optional(),
  })
  .strict();

/** Strict comment body. */
export const commentBodySchema = z
  .object({
    contentRef: uuid,
    body: z.string().min(1).max(2000),
    parentCommentId: uuid.optional(),
  })
  .strict();

/** Strict share body. */
export const shareBodySchema = z
  .object({
    contentRef: uuid,
    channel: z.enum(["copy_link", "external"]),
  })
  .strict();

/** Shared GET query for own-state list routes. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
