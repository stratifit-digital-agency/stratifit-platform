import { NextResponse } from "next/server";
import { flatten, getMyConversation, principalOf, toAudienceConversationView, toAudienceMessageView } from "@/lib/messaging";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * GET /api/me/conversations/[id] — the owner's conversation thread with its
 * messages (owner-scoped; foreign conversations are 404, no existence leak).
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Sign in to view your conversations.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: 401 },
    );
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "conversation id must be a uuid.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: 400 },
    );
  }
  const result = await getMyConversation(principalOf(identity), id);
  const flat = flatten(result);
  if (!flat.ok) {
    return NextResponse.json(
      { error: { code: flat.code, message: flat.message, correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: flat.status },
    );
  }
  return NextResponse.json({
    conversation: toAudienceConversationView(flat.value.conversation),
    messages: flat.value.messages.map(toAudienceMessageView),
  });
}
