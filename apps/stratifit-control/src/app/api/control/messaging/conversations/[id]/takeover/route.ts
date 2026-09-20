import { handleTakeover } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/conversations/[id]/takeover
 *   POST — operator takeover (messaging.takeover); requires awaiting_human.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleTakeover(request, id);
}
