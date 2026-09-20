import { handleCreateAiCreator, handleListPeople } from "@/lib/people-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/people/ai-creators
 *   GET  — list the operator's org AI creators (people.read)
 *   POST — author an AI creator (people.manage)
 */
export async function GET(request: Request) {
  return handleListPeople(request, "ai-creators");
}

export async function POST(request: Request) {
  return handleCreateAiCreator(request);
}
