import { handleCreateCreative, handleListCreative } from "@/lib/creative-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/creative/scenes
 *   GET  — list the operator's org scenes (creative.read)
 *   POST — author a scene (creative.manage)
 */
export async function GET(request: Request) {
  return handleListCreative(request, "scenes");
}

export async function POST(request: Request) {
  return handleCreateCreative(request, "scenes");
}
