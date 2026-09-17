import { handleCreateProduction, handleListProductions } from "@/lib/production-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/productions
 *   GET  — list productions in the operator's organization (production.plan)
 *   POST — create a production (production.plan)
 * Thin adapter: authentication, capability checks, validation, and the
 * section 13 error envelope live in lib/production-commands.
 */
export async function GET(request: Request) {
  return handleListProductions(request);
}

export async function POST(request: Request) {
  return handleCreateProduction(request);
}
