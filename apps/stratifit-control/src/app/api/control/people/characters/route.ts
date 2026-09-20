import { handleCreateCharacter, handleListPeople } from "@/lib/people-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/people/characters
 *   GET  — list the operator's org characters (people.read)
 *   POST — author a character (people.manage)
 */
export async function GET(request: Request) {
  return handleListPeople(request, "characters");
}

export async function POST(request: Request) {
  return handleCreateCharacter(request);
}
