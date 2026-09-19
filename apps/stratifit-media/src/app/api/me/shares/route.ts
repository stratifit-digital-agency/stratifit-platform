import { share } from "@/lib/social";
import {
  errorEnvelope,
  requirePrincipal,
  shareBodySchema,
  unauthorized,
  unauthorizedVerified,
  writeResponse,
} from "@/lib/social-route";

export const dynamic = "force-dynamic";

/** POST /api/me/shares — record a share fact (email-verified; immutable). */
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
  const parsed = shareBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope("validation_error", 400, "Invalid body.", parsed.error.flatten().fieldErrors);
  }
  const outcome = await share(principal, parsed.data);
  if (outcome.ok) {
    return Response.json({ status: outcome.state, shareId: outcome.id }, { status: 201 });
  }
  return writeResponse(outcome);
}
