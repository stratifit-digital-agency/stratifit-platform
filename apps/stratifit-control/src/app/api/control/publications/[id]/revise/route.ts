import { handlePublishingRevise } from "@/lib/publishing-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/publications/[id]/revise — draft-only correction that
 * appends immutable version N+1 (production.publish, D2.12-E). Active or
 * terminal publications reject revise; a superseding subject creates a new
 * publication instead.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handlePublishingRevise(request, id);
}
