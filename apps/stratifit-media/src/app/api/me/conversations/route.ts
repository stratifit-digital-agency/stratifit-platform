import { NextResponse } from "next/server";
import { flatten, listMyConversations, principalOf, toAudienceConversationView } from "@/lib/messaging";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * GET /api/me/conversations — the authenticated audience user's own
 * conversations (owner-scoped; server-derived principal). Whitelisted view
 * only. Anonymous callers receive the §13 unauthenticated envelope.
 */
export async function GET(request: Request) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Sign in to view your conversations.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: 401 },
    );
  }
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "limit must be an integer between 1 and 200.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: 400 },
    );
  }
  const result = await listMyConversations(principalOf(identity), limit === undefined ? {} : { limit });
  const flat = flatten(result);
  if (!flat.ok) {
    return NextResponse.json(
      { error: { code: flat.code, message: flat.message, correlationId: `req_${crypto.randomUUID()}`, retryable: flat.code === "rate_limited" } },
      { status: flat.status },
    );
  }
  return NextResponse.json({ conversations: flat.value.map(toAudienceConversationView) });
}
