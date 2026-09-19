import { handlePublishingSubmit } from "@/lib/publishing-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/publications/[id]/submit — draft → pending_approval
 * (production.publish). Invalid transitions fail with domain_rule_violation.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handlePublishingSubmit(request, id);
}
