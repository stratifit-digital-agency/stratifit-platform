import { handleDeleteRequirement, handleUpdateRequirement } from "@/lib/rights-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/rights/requirements/[id]
 *   PATCH  — correct a `record_only` declaration (rights.manage). D2.22-3:
 *   `enforce` rows are IMMUTABLE and reject with a domain validation error —
 *   retire by DELETE + re-create instead.
 *   DELETE — retire a declaration (rights.manage; audited).
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleUpdateRequirement(request, id);
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleDeleteRequirement(request, id);
}
