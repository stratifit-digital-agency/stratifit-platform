import { handleRecordQcDecision } from "@/lib/qc-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/qc/reviews/[id]/decision — record approve/reject/
 * changes_requested (production.approve). The state transition and the
 * immutable decision record commit in the SAME transaction; qc.approved /
 * qc.rejected are emitted post-commit (changes_requested emits no event).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleRecordQcDecision(request, id);
}
