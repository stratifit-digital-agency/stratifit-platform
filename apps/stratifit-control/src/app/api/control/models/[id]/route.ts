import { handleUpdateModelStatus } from "@/lib/catalog-commands";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/control/models/[id] — update the registry status
 * (`active` / `deprecated` / `disabled`; model.manage). Historical versions
 * are never deleted or rewritten — status transitions only.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleUpdateModelStatus(request, id);
}
