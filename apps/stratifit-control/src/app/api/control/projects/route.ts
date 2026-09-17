import { handleCreateProject, handleListProjects } from "@/lib/production-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/projects
 *   GET  — list projects in the operator's organization (production.plan)
 *   POST — create a project (production.plan)
 * Thin adapter: authentication, capability checks, validation, and the
 * section 13 error envelope live in lib/production-commands.
 */
export async function GET(request: Request) {
  return handleListProjects(request);
}

export async function POST(request: Request) {
  return handleCreateProject(request);
}
