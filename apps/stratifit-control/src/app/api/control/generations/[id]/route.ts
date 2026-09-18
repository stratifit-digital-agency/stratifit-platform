import { handleGetGeneration } from "@/lib/generation-commands";

export const dynamic = "force-dynamic";

/**
 * GET /api/control/generations/[id] — read one generation with its
 * completion provenance (generation.request; API_ARCHITECTURE §7.283
 * "request generation, read provenance"). Thin adapter: authentication,
 * capability checks, and the section 13 error envelope live in
 * lib/generation-commands.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleGetGeneration(request, id);
}
