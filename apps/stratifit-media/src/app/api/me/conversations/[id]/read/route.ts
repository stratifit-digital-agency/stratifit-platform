import { NextResponse } from "next/server";
import { z } from "zod";
import { flatten, markMyConversationRead, principalOf } from "@/lib/messaging";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * POST /api/me/conversations/[id]/read — the owner marks their conversation
 * read (D2.17-8: monotonic advance-only receipt; optional explicit messageId;
 * no-op returns applied=false with no event).
 */
const readBody = z.object({ messageId: z.string().uuid().optional() }).strict();

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Sign in to update read state.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
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
  let raw: unknown = {};
  try {
    raw = await request.json().catch(() => ({}));
  } catch {
    raw = {};
  }
  const parsed = readBody.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "The read request is invalid.", correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: 400 },
    );
  }
  const result = await markMyConversationRead(principalOf(identity), {
    conversationId: id,
    ...(parsed.data.messageId !== undefined ? { messageId: parsed.data.messageId } : {}),
  });
  const flat = flatten(result);
  if (!flat.ok) {
    return NextResponse.json(
      { error: { code: flat.code, message: flat.message, correlationId: `req_${crypto.randomUUID()}`, retryable: false } },
      { status: flat.status },
    );
  }
  return NextResponse.json({ applied: flat.value.applied });
}
