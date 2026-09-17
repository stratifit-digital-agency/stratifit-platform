import { handleCreateTeam, handleListTeams } from "@/lib/admin-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/admin/teams
 *   GET  — list teams in the operator's organization (admin.permissions)
 *   POST — create a team (admin.permissions)
 * Thin adapter: authentication, capability checks, validation, and the
 * section 13 error envelope live in lib/admin-commands.
 */
export async function GET(request: Request) {
  return handleListTeams(request);
}

export async function POST(request: Request) {
  return handleCreateTeam(request);
}
