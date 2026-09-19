import { handlePublishingApprove } from "@/lib/publishing-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/publications/[id]/approve — pending_approval → approved,
 * gated fail-closed on QC eligibility and rights requirements
 * (production.publish).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handlePublishingApprove(request, id);
}
