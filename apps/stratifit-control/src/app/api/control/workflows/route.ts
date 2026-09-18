import { handleCreateWorkflow, handleListWorkflows } from "@/lib/catalog-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/workflows
 *   GET  — list workflows in the operator's organization (workflow.manage)
 *   POST — register a workflow (workflow.manage)
 * Thin adapter: authentication, capability checks, validation, and the
 * section 13 error envelope live in lib/catalog-commands.
 */
export async function GET(request: Request) {
  return handleListWorkflows(request);
}

export async function POST(request: Request) {
  return handleCreateWorkflow(request);
}
