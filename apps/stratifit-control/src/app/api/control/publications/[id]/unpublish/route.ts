import { handlePublishingUnpublish } from "@/lib/publishing-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/publications/[id]/unpublish — published → unpublished
 * (terminal; production.publish). No publication.unpublished event exists —
 * this transition is audit-recorded only, per the approved plan.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handlePublishingUnpublish(request, id);
}
