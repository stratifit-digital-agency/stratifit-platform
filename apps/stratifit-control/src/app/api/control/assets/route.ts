import { handleRegisterAsset } from "@/lib/assets-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/assets — register an asset (production.plan).
 * Thin adapter: authentication, capability checks, validation, and the
 * section 13 error envelope live in lib/assets-commands. The organization
 * is always server-derived from the authenticated operator.
 */
export async function POST(request: Request) {
  return handleRegisterAsset(request);
}
