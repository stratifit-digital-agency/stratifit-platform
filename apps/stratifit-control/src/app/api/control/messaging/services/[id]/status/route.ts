import { handleSetServiceOfferingStatus } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/services/[id]/status
 *   POST — set a service offering's status (active | retired) (lead.assign).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleSetServiceOfferingStatus(request, id);
}
