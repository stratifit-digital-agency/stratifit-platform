import { NextResponse } from "next/server";
import { z } from "zod";
import { flatten, principalOf, replyToMyConversation, toAudienceMessageView } from "@/lib/messaging";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * POST /api/me/conversations/[id]/reply — the owner replies to their own
 * conversation (human authorship derived server-side; closed conversations
 * fail closed; D2.17-9 shared send budget → 429).
 */
const replyBody = z.object({ body: z.string().min(1).max(4000) }).strict();

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Sign in to reply.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
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
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "validation_error", message: "Request body must be valid JSON.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: 400 },
    );
  }
  const parsed = replyBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "The reply is invalid.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: 400 },
    );
  }
  const result = await replyToMyConversation(principalOf(identity), { conversationId: id, body: parsed.data.body });
  const flat = flatten(result);
  if (!flat.ok) {
    return NextResponse.json(
      { error: { code: flat.code, message: flat.message, correlationId: `req_${crypto.randomUUID()}`, retryable: flat.code === "rate_limited" } },
      { status: flat.status },
    );
  }
  return NextResponse.json(toAudienceMessageView(flat.value), { status: 201 });
}
