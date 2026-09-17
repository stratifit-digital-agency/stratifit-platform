import { handleSubmitToGate } from "@/lib/production-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/productions/[id]/gate — evaluate the production gate and
 * record the immutable GateDecisionRecord (production.plan). Moves a planning
 * production into in_gate.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleSubmitToGate(request, id);
}
