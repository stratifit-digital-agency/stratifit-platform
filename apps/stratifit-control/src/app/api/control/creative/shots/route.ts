import { handleCreateCreative, handleListCreative } from "@/lib/creative-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/creative/shots
 *   GET  — list the operator's org shots (creative.read)
 *   POST — author a shot (creative.manage)
 */
export async function GET(request: Request) {
  return handleListCreative(request, "shots");
}

export async function POST(request: Request) {
  return handleCreateCreative(request, "shots");
}
