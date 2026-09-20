import { handleListProfiles } from "@/lib/people-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/people/profiles
 *   GET — list the operator's org creator-profile snapshot family (people.read).
 *
 * READ-ONLY: there is deliberately NO write route for creator_profiles — the
 * snapshot family is publication-authored (D2.16-3).
 */
export async function GET(request: Request) {
  return handleListProfiles(request);
}
