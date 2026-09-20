import { handleChangeStatus } from "@/lib/people-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/people/personas/[id]/status
 *   POST — change the aggregate lifecycle status (people.manage).
 * draft → active → retired; invalid transitions fail closed.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleChangeStatus(request, "personas", id);
}
