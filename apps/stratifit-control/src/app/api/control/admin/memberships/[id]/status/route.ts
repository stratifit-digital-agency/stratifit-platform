import { handleChangeMembershipStatus } from "@/lib/admin-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/admin/memberships/[id]/status — transition membership
 * status (admin.permissions). Revocation is a separate route because the
 * service treats it as a distinct immutable-history action.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleChangeMembershipStatus(request, id);
}
