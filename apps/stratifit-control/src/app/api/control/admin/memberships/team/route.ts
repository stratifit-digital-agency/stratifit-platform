import { handleGrantTeamAssignment } from "@/lib/admin-commands";

export const dynamic = "force-dynamic";

/** POST /api/control/admin/memberships/team — assign an operator to a team (admin.permissions). */
export async function POST(request: Request) {
  return handleGrantTeamAssignment(request);
}
