import { handlePublishingSchedule } from "@/lib/publishing-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/publications/[id]/schedule — approved → scheduled with a
 * future scheduledFor timestamp (production.publish). This is the ONLY path
 * out of `approved`.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handlePublishingSchedule(request, id);
}
