import { handleCreateGrant, handleListGrants } from "@/lib/rights-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/rights/grants
 *   GET  — list the operator's org rights grants (rights.read)
 *   POST — author a rights grant (rights.manage). Owner + subject integrity
 *   is validated inside the service transaction (same-org, fail-closed).
 */
export async function GET(request: Request) {
  return handleListGrants(request);
}

export async function POST(request: Request) {
  return handleCreateGrant(request);
}
