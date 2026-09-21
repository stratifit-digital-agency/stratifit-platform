import { handleCreateCreative, handleListCreative } from "@/lib/creative-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/creative/stories
 *   GET  — list the operator's org stories (creative.read)
 *   POST — author a storie (creative.manage)
 */
export async function GET(request: Request) {
  return handleListCreative(request, "stories");
}

export async function POST(request: Request) {
  return handleCreateCreative(request, "stories");
}
