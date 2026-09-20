import { handleAssignLead } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/leads/[id]/assign
 *   POST — assign the lead (records the ASSIGNING operator; requires triaged;
 *          lead.assign; emits lead.assigned).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleAssignLead(request, id);
}
