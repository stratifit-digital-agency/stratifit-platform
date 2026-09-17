import { handleAuditTrail } from "@/lib/admin-commands";

export const dynamic = "force-dynamic";

/**
 * GET /api/control/admin/audit — the org-scoped audit trail (audit.read).
 * Filters: action, subjectKind, subjectId, actorId; direction; cursor; limit.
 * Reads are organization-scoped to the resolved operator context (D2.4-2);
 * audit records never leave their trust boundary via Media.
 */
export async function GET(request: Request) {
  return handleAuditTrail(request);
}
