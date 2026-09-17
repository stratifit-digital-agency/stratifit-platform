import { handleArchiveTeam } from "@/lib/admin-commands";

export const dynamic = "force-dynamic";

/** POST /api/control/admin/teams/[id]/archive — archive a team (admin.permissions). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleArchiveTeam(request, id);
}
