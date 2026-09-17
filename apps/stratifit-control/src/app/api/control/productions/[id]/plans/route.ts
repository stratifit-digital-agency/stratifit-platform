import { handleRecordPlanVersion } from "@/lib/production-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/productions/[id]/plans — record a new immutable plan
 * version (production.plan). Version rows are append-only (D2.6-4).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleRecordPlanVersion(request, id);
}
