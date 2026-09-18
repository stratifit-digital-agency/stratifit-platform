import { handleCreateWorkflowVersion } from "@/lib/catalog-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/workflows/[id]/versions — register a new immutable
 * workflow version (workflow.manage). Version rows are append-only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCreateWorkflowVersion(request, id);
}
