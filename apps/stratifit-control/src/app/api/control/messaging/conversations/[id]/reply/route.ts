import { handleReplyConversation } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/conversations/[id]/reply
 *   POST — operator reply (messaging.takeover). awaiting_ai → active;
 *   awaiting_human → active via takeover; open/closed fail closed.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleReplyConversation(request, id);
}
