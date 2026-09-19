import { comment } from "@/lib/social";
import {
  commentBodySchema,
  errorEnvelope,
  requirePrincipal,
  unauthorized,
  unauthorizedVerified,
  writeResponse,
} from "@/lib/social-route";

export const dynamic = "force-dynamic";

/** POST /api/me/comments — comment on published content (email-verified). */
export async function POST(request: Request) {
  const principal = await requirePrincipal(request);
  if (!principal) return unauthorized();
  if (!principal.emailVerified) return unauthorizedVerified();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorEnvelope("validation_error", 400, "Body must be valid JSON.");
  }
  const parsed = commentBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope("validation_error", 400, "Invalid body.", parsed.error.flatten().fieldErrors);
  }
  const outcome = await comment(principal, {
    contentRef: parsed.data.contentRef,
    body: parsed.data.body,
    parentCommentId: parsed.data.parentCommentId ?? null,
  });
  if (outcome.ok) {
    return Response.json({ status: outcome.state, commentId: outcome.id }, { status: 201 });
  }
  return writeResponse(outcome);
}
