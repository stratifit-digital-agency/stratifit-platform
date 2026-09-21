import { handleCreateRequirement, handleListRequirements } from "@/lib/rights-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/rights/requirements
 *   GET  — list the operator's org rights requirements (rights.read)
 *   POST — record a requirements declaration (rights.manage). D2.22-2: the
 *   ABSENCE of a declaration keeps the vacuous pass; recording one is what
 *   makes rights relevant for the subject+scope. Nothing consumes these
 *   declarations in Stage 2.22 (D2.22-4: cutover deferred to Stage 2.23).
 */
export async function GET(request: Request) {
  return handleListRequirements(request);
}

export async function POST(request: Request) {
  return handleCreateRequirement(request);
}
