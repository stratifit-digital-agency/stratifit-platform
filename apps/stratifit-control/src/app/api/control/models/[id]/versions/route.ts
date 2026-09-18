import { handleCreateModelVersion } from "@/lib/catalog-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/models/[id]/versions — register a new immutable model
 * version (model.manage). Version rows are append-only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCreateModelVersion(request, id);
}
