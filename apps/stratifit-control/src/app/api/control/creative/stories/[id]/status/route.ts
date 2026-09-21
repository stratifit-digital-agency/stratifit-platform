import { handleChangeCreativeStatus } from "@/lib/creative-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/creative/stories/[id]/status
 *   PATCH — change the aggregate lifecycle status (creative.manage).
 * draft → active → completed → retired (completed exits only to retired); invalid transitions fail closed.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleChangeCreativeStatus(request, "stories", id);
}
