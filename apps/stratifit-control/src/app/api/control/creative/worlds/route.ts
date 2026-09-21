import { handleCreateCreative, handleListCreative } from "@/lib/creative-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/creative/worlds
 *   GET  — list the operator's org worlds (creative.read)
 *   POST — author a world (creative.manage)
 */
export async function GET(request: Request) {
  return handleListCreative(request, "worlds");
}

export async function POST(request: Request) {
  return handleCreateCreative(request, "worlds");
}
