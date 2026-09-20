import { handleCreatePersona, handleListPeople } from "@/lib/people-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/people/personas
 *   GET  — list the operator's org personas (people.read)
 *   POST — author a persona (people.manage)
 */
export async function GET(request: Request) {
  return handleListPeople(request, "personas");
}

export async function POST(request: Request) {
  return handleCreatePersona(request);
}
