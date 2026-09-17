import { handleGrantOrgMembership } from "@/lib/admin-commands";

export const dynamic = "force-dynamic";

/** POST /api/control/admin/memberships/org — grant an org membership role (admin.permissions). */
export async function POST(request: Request) {
  return handleGrantOrgMembership(request);
}
