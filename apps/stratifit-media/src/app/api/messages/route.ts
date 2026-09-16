import { NextResponse } from "next/server";
import { startConversation } from "@/lib/messaging";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * Public BFF endpoint for starting a conversation with an AI profile.
 *
 * Server-side enforcement:
 * - Identity comes from the (future) Supabase session; anonymous callers are
 *   rejected. No client-supplied authorization is trusted.
 * - Email verification is required before messaging (pure rule in
 *   @stratifit/auth).
 * - No production, compute, or model capability is reachable from here.
 *
 * Error responses use the API_ARCHITECTURE section 13 envelope (T8 migration):
 *   { error: { code, message, correlationId, fieldErrors?, retryable } }
 * Success follows section 12 (commands return their outcome directly):
 *   201 { conversationId }
 * The seed status mapping (401/403/400) is preserved, and seed reasons map to
 * the classified section 13 codes at this BFF boundary (not_authenticated ->
 * unauthenticated; invalid_request -> validation_error). Domain behavior
 * lives in lib/messaging and is unchanged by this envelope migration.
 */

type SeedReason = "not_authenticated" | "email_verification_required" | "invalid_request";

const SEED_ERROR_MAP: Record<
  SeedReason,
  { code: string; status: number; message: string }
> = {
  not_authenticated: {
    code: "unauthenticated",
    status: 401,
    message: "Sign in to start a conversation.",
  },
  email_verification_required: {
    code: "email_verification_required",
    status: 403,
    message: "Email verification is required before messaging.",
  },
  invalid_request: {
    code: "validation_error",
    status: 400,
    message: "The message request is invalid.",
  },
};

const errorResponse = (code: string, status: number, message: string) =>
  NextResponse.json(
    {
      error: {
        code,
        message,
        correlationId: `req_${crypto.randomUUID()}`,
        retryable: false,
      },
    },
    { status },
  );

export async function POST(request: Request) {
  // Stage 2.1: identity is resolved server-side from the session via the
  // public-safe identity fragment (CD-1). Anonymous callers stay null and
  // receive the unauthenticated envelope; unverified callers receive the
  // email_verification_required envelope — enforced by lib/messaging.
  const identity = await resolveMediaIdentity(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("validation_error", 400, "Request body must be valid JSON.");
  }

  const result = startConversation(identity, raw);
  if (!result.ok) {
    const seed = SEED_ERROR_MAP[result.reason];
    return errorResponse(seed.code, seed.status, seed.message);
  }

  return NextResponse.json({ conversationId: result.conversationId }, { status: 201 });
}
