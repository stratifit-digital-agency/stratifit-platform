import { handleRecordFollowUp } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/leads/[id]/follow-ups
 *   POST — append an immutable follow-up note to the lead (lead.assign).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleRecordFollowUp(request, id);
}
