import { handleGetProduction } from "@/lib/production-commands";

export const dynamic = "force-dynamic";

/** GET /api/control/productions/[id] — read one production (production.plan). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleGetProduction(request, id);
}
