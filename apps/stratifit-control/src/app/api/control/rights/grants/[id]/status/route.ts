import { handleGrantStatus } from "@/lib/rights-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/rights/grants/[id]/status
 *   PATCH — change grant lifecycle status (rights.manage).
 * draft → active; active → suspended|revoked|expired; suspended →
 * active|revoked|expired. revoked/expired TERMINAL. Every accepted transition
 * appends the immutable rights_status_events row in the same transaction.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleGrantStatus(request, id);
}
