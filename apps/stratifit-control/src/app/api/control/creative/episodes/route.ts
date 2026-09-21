import { handleCreateCreative, handleListCreative } from "@/lib/creative-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/creative/episodes
 *   GET  — list the operator's org episodes (creative.read)
 *   POST — author a episode (creative.manage)
 */
export async function GET(request: Request) {
  return handleListCreative(request, "episodes");
}

export async function POST(request: Request) {
  return handleCreateCreative(request, "episodes");
}
