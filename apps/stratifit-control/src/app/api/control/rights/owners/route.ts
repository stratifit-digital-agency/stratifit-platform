import { handleCreateOwner, handleListOwners } from "@/lib/rights-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/rights/owners
 *   GET  — list the operator's org rights owners (rights.read)
 *   POST — author a rights owner (rights.manage)
 */
export async function GET(request: Request) {
  return handleListOwners(request);
}

export async function POST(request: Request) {
  return handleCreateOwner(request);
}
