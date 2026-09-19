import { handleGetPublication } from "@/lib/publishing-commands";

export const dynamic = "force-dynamic";

/**
 * GET /api/control/publications/[id] — read a publication with its versions
 * and distribution references (production.publish). Cross-org ids are
 * indistinguishable from absent ones (IDOR-safe, not_found).
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleGetPublication(request, id);
}
