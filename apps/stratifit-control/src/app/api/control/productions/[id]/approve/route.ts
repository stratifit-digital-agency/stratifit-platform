import { handleRecordGateDecision } from "@/lib/production-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/productions/[id]/approve — record the gate decision
 * (`approve` | `changes_requested`) (production.approve). Approval requires a
 * recorded passing gate decision for the current plan version (invariant 1)
 * and is audited in the same transaction (D2.4-1).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleRecordGateDecision(request, id);
}
