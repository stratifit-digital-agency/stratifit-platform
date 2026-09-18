import { handleRequestGeneration } from "@/lib/generation-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/generations — request a generation (generation.request).
 * Thin adapter: authentication, capability checks, validation, and the
 * section 13 error envelope live in lib/generation-commands. Idempotency
 * key supported via `requestKey` (unique per organization).
 */
export async function POST(request: Request) {
  return handleRequestGeneration(request);
}
