import { listPublicComments } from "@/lib/social";
import { errorEnvelope, uuid } from "@/lib/social-route";
import { z } from "zod";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

/**
 * GET /api/content/[contentRef]/comments — PUBLIC visible-comments read on
 * PUBLISHED content. Anonymous callers are allowed (D2.15-4: public reads of
 * visible comments). Unknown/unpublished content → 404 with NO existence
 * leak (same body for both cases). The response whitelist is enforced by
 * the BFF view: commentId, body, createdAt, parentCommentId, authorHandle —
 * never author ids, org identity, or moderation internals.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contentRef: string }> },
) {
  const { contentRef } = await params;
  const parsedRef = uuid.safeParse(contentRef);
  if (!parsedRef.success) {
    return errorEnvelope("content_not_found", 404, "No published content for this reference.");
  }
  const url = new URL(request.url);
  const parsedQuery = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsedQuery.success) {
    return errorEnvelope("validation_error", 400, "Invalid query.", parsedQuery.error.flatten().fieldErrors);
  }
  const items = await listPublicComments(parsedRef.data, parsedQuery.data.limit);
  if (items === null) {
    return errorEnvelope("content_not_found", 404, "No published content for this reference.");
  }
  return Response.json({ items });
}
