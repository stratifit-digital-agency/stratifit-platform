import { handleCreateCreative, handleListCreative } from "@/lib/creative-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/creative/universes
 *   GET  — list the operator's org universes (creative.read)
 *   POST — author a universe (creative.manage)
 */
export async function GET(request: Request) {
  return handleListCreative(request, "universes");
}

export async function POST(request: Request) {
  return handleCreateCreative(request, "universes");
}
