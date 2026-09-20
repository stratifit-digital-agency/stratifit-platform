import { handleGetServiceLead } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/leads/[id]
 *   GET — lead detail with its immutable follow-up history (lead.assign).
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleGetServiceLead(request, id);
}
