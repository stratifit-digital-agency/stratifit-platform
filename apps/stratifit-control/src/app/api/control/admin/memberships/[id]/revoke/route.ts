import { handleRevokeMembership } from "@/lib/admin-commands";

export const dynamic = "force-dynamic";

/** POST /api/control/admin/memberships/[id]/revoke — revoke (immutable history) (admin.permissions). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleRevokeMembership(request, id);
}
