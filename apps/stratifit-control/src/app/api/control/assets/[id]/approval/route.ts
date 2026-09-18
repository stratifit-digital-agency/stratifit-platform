import { handleAssetApproval } from "@/lib/assets-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/assets/[id]/approval — advance the DM section 32.4
 * approval state machine on the asset aggregate (production.plan): action =
 * submit_for_review | approve | reject. Thin adapter: authentication,
 * capability checks, validation, and the section 13 error envelope live in
 * lib/assets-commands. Cross-org ids resolve to not_found (IDOR-safe).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleAssetApproval(request, id);
}
