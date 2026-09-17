import { handleListMembers } from "@/lib/admin-commands";

export const dynamic = "force-dynamic";

/**
 * GET /api/control/admin/members?includeRevoked=true|false
 * List organization members (admin.permissions). Revoked rows are history
 * (append-and-revoke) and are excluded unless explicitly requested.
 */
export async function GET(request: Request) {
  return handleListMembers(request);
}
