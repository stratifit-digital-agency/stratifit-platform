import { handleSetLeadStatus } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/leads/[id]/status
 *   POST — change lead status through the frozen linear machine (lead.assign).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleSetLeadStatus(request, id);
}
