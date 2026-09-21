import { handleOwnerVerification } from "@/lib/rights-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/rights/owners/[id]/status
 *   PATCH — change owner verification status (rights.manage).
 * unverified → pending → verified|rejected; verified/rejected → pending
 * (re-review). Invalid transitions fail closed.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleOwnerVerification(request, id);
}
