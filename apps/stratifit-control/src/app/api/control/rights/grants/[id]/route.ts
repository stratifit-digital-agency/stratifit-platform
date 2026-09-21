import { handleGetGrant } from "@/lib/rights-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/rights/grants/[id]
 *   GET — grant detail including the immutable status-event history
 *   (rights.read). Cross-org grants are indistinguishable from absent ones
 *   (IDOR-safe not_found).
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleGetGrant(request, id);
}
