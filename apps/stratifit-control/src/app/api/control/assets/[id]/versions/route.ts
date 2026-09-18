import { handleRegisterAssetVersion } from "@/lib/assets-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/assets/[id]/versions — register an immutable asset
 * version (production.plan). Thin adapter: authentication, capability
 * checks, validation, and the section 13 error envelope live in
 * lib/assets-commands. Cross-org ids resolve to not_found (IDOR-safe).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleRegisterAssetVersion(request, id);
}
