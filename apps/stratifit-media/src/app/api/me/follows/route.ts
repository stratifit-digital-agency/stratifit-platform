import { follow, unfollow } from "@/lib/social";
import { followBodySchema, requirePrincipal, unauthorized, writeResponse } from "@/lib/social-route";

export const dynamic = "force-dynamic";

/** POST /api/me/follows — follow an audience user (tombstone-aware). */
export async function POST(request: Request) {
  const principal = await requirePrincipal(request);
  if (!principal) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return writeResponse({ ok: false, reason: "invalid_body", message: "Body must be valid JSON." });
  }
  const parsed = followBodySchema.safeParse(body);
  if (!parsed.success) {
    return writeResponse({ ok: false, reason: "invalid_body", message: "Invalid body." });
  }
  return writeResponse(await follow(principal, parsed.data.followeeRef), 201);
}

/** DELETE /api/me/follows — unfollow (tombstone; idempotent). */
export async function DELETE(request: Request) {
  const principal = await requirePrincipal(request);
  if (!principal) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return writeResponse({ ok: false, reason: "invalid_body", message: "Body must be valid JSON." });
  }
  const parsed = followBodySchema.safeParse(body);
  if (!parsed.success) {
    return writeResponse({ ok: false, reason: "invalid_body", message: "Invalid body." });
  }
  return writeResponse(await unfollow(principal, parsed.data.followeeRef));
}
