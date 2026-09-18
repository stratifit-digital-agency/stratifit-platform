import { handleGetQcReview } from "@/lib/qc-commands";

export const dynamic = "force-dynamic";

/**
 * GET /api/control/qc/reviews/[id] — read a review with its results,
 * decisions, and issues (production.approve). Cross-org ids are
 * indistinguishable from absent ones (IDOR-safe, not_found).
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleGetQcReview(request, id);
}
