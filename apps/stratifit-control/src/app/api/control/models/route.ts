import { handleCreateModel, handleListModels } from "@/lib/catalog-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/models
 *   GET  — list models in the operator's organization (model.manage)
 *   POST — register a model (model.manage)
 * Thin adapter: authentication, capability checks, validation, and the
 * section 13 error envelope live in lib/catalog-commands.
 */
export async function GET(request: Request) {
  return handleListModels(request);
}

export async function POST(request: Request) {
  return handleCreateModel(request);
}
