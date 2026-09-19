import { listLikes } from "@/lib/social";
import { listQuerySchema, errorEnvelope, requirePrincipal, unauthorized } from "@/lib/social-route";

export const dynamic = "force-dynamic";

/** GET /api/me/likes/list — owner-scoped like list (opaque contentRefs). */
export async function GET(request: Request) {
  const principal = await requirePrincipal(request);
  if (!principal) return unauthorized();
  const url = new URL(request.url);
  const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return errorEnvelope("validation_error", 400, "Invalid query.", parsed.error.flatten().fieldErrors);
  }
  const items = await listLikes(principal, parsed.data.limit);
  return Response.json({ items });
}
