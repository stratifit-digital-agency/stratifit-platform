import { listCreators } from "@/lib/creators";
import { errorEnvelope } from "@/lib/social-route";
import { z } from "zod";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

/**
 * GET /api/creators — PUBLIC creator directory (Stage 2.16, D2.16-8).
 * Anonymous callers allowed. ACTIVE profiles only; the whitelist is enforced
 * by the People public projection (handle, displayName, bio, interests,
 * avatarRef, posterRef, status) — never internal row ids, org ids, storage
 * paths/URLs, or credentials. No mutation route exists for this surface.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsedQuery = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsedQuery.success) {
    return errorEnvelope("validation_error", 400, "Invalid query.", parsedQuery.error.flatten().fieldErrors);
  }
  const items = await listCreators(parsedQuery.data.limit);
  return Response.json({ items });
}
