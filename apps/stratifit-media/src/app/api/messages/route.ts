import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAudienceAction } from "@stratifit/auth";
import { MessageRequest } from "@stratifit/contracts";
import { flatten, principalOf, sendFirstMessage } from "@/lib/messaging";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * Public BFF endpoint for starting a conversation with an AI creator profile
 * (Stage 2.17 — durable conversations replace the Stage-2.1 placeholder).
 *
 * Server-side enforcement:
 * - Identity is resolved server-side from the session (CD-1); anonymous
 *   callers are rejected. No client-supplied authorization is trusted.
 * - Email verification is required before messaging (pure rule in
 *   @stratifit/auth; the service re-checks fail-closed).
 * - Creator resolution happens SERVER-SIDE from the handle (narrow People
 *   seam): unknown/inactive handles return 404 with no existence leak.
 * - D2.17-9 rate limit: 10 sends / 60s per audience user → 429.
 * - No production, compute, or model capability is reachable from here.
 *
 * §13 envelope: errors { error: { code, message, correlationId, retryable } };
 * 201 { conversationId, messageId, conversationCreated } on success.
 */

const startBody = z
  .object({
    creatorHandle: z.string().regex(/^[a-z0-9-]{3,64}$/),
    body: z.string().min(1).max(4000),
    subject: z.string().max(200).optional(),
  })
  .strict();

const errorResponse = (code: string, status: number, message: string) =>
  NextResponse.json(
    {
      error: {
        code,
        message,
        correlationId: `req_${crypto.randomUUID()}`,
        retryable: code === "rate_limited",
      },
    },
    { status },
  );

export async function POST(request: Request) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) return errorResponse("unauthenticated", 401, "Sign in to start a conversation.");

  // Pure-rule BFF gate (unchanged from Stage 2.1): email verification first.
  const decision = authorizeAudienceAction(identity, "message");
  if (!decision.allowed) {
    return errorResponse(
      decision.reason === "email_verification_required" ? "email_verification_required" : "unauthenticated",
      decision.reason === "email_verification_required" ? 403 : 401,
      decision.reason === "email_verification_required"
        ? "Email verification is required before messaging."
        : "Sign in to start a conversation.",
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("validation_error", 400, "Request body must be valid JSON.");
  }
  const parsed = startBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("validation_error", 400, "The message request is invalid.");
  }

  const result = await sendFirstMessage(principalOf(identity), {
    creatorHandle: parsed.data.creatorHandle,
    body: parsed.data.body,
    ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
  });
  const flat = flatten(result);
  if (!flat.ok) return errorResponse(flat.code, flat.status, flat.message);

  return NextResponse.json(
    { conversationId: flat.value.conversationId, messageId: flat.value.messageId, conversationCreated: flat.value.conversationCreated },
    { status: 201 },
  );
}
