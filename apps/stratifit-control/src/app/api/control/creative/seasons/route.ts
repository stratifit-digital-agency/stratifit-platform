import { handleCreateCreative, handleListCreative } from "@/lib/creative-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/creative/seasons
 *   GET  — list the operator's org seasons (creative.read)
 *   POST — author a season (creative.manage)
 */
export async function GET(request: Request) {
  return handleListCreative(request, "seasons");
}

export async function POST(request: Request) {
  return handleCreateCreative(request, "seasons");
}
