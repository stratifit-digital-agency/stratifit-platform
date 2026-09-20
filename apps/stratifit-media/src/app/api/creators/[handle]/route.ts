import { getCreatorByHandle } from "@/lib/creators";
import { errorEnvelope, handleShape } from "@/lib/social-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/creators/[handle] — PUBLIC creator detail by handle (D2.16-8).
 * Unknown or inactive handle → 404 with NO existence leak (same body for
 * unknown and paused/unpublished profiles — only ACTIVE profiles resolve).
 * Same public whitelist as the directory route.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle } = await params;
  const parsed = handleShape.safeParse(handle);
  if (!parsed.success) {
    return errorEnvelope("creator_not_found", 404, "No active creator profile for this handle.");
  }
  const creator = await getCreatorByHandle(parsed.data);
  if (!creator) {
    return errorEnvelope("creator_not_found", 404, "No active creator profile for this handle.");
  }
  return Response.json({ creator });
}
