import { handleCreateDigitalHuman, handleListPeople } from "@/lib/people-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/people/digital-humans
 *   GET  — list the operator's org digital humans (people.read)
 *   POST — author a digital human (people.manage)
 */
export async function GET(request: Request) {
  return handleListPeople(request, "digital-humans");
}

export async function POST(request: Request) {
  return handleCreateDigitalHuman(request);
}
