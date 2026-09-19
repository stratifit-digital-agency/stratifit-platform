import { save, unsave } from "@/lib/social";
import { requirePrincipal, toggleBodySchema, unauthorized, writeResponse } from "@/lib/social-route";

export const dynamic = "force-dynamic";

/** POST /api/me/saves — save published content (idempotent). */
export async function POST(request: Request) {
  const principal = await requirePrincipal(request);
  if (!principal) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return writeResponse({ ok: false, reason: "invalid_body", message: "Body must be valid JSON." });
  }
  const parsed = toggleBodySchema.safeParse(body);
  if (!parsed.success) {
    return writeResponse({ ok: false, reason: "invalid_body", message: "Invalid body." });
  }
  return writeResponse(await save(principal, parsed.data.contentRef), 201);
}

/** DELETE /api/me/saves — unsave (hard-delete toggle, idempotent). */
export async function DELETE(request: Request) {
  const principal = await requirePrincipal(request);
  if (!principal) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return writeResponse({ ok: false, reason: "invalid_body", message: "Body must be valid JSON." });
  }
  const parsed = toggleBodySchema.safeParse(body);
  if (!parsed.success) {
    return writeResponse({ ok: false, reason: "invalid_body", message: "Invalid body." });
  }
  return writeResponse(await unsave(principal, parsed.data.contentRef));
}
