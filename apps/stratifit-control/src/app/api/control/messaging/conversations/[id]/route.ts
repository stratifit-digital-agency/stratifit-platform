import { handleGetConversation } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/conversations/[id]
 *   GET — org-scoped conversation thread (messaging.takeover).
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleGetConversation(request, id);
}
