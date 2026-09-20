import { NextResponse } from "next/server";
import { z } from "zod";
import { countMyUnread, markMineRead } from "@/lib/notifications";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * Mark notifications read (Stage 2.18, D2.18-P2).
 *
 * Strict body union: { all: true } | { ids: uuid[] (1..100) }. The owner is
 * the SERVER-DERIVED audience identity; foreign-owner or cross-org ids are
 * natural no-ops; only rows where read_at IS NULL move (idempotent). No
 * audit (D2.14-2 precedent); no rate limiting (frozen); Section 13 envelope.
 */

const uuid = z.string().uuid();

// Plain union (Zod v4 discriminatedUnion requires the discriminator key on
// every option); the .strict() objects are mutually exclusive, so
// { all: true, ids } and any unknown field are still rejected.
const postBodySchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(uuid).min(1).max(100) }).strict(),
]);

const errorEnvelope = (code: string, status: number, message: string, fieldErrors?: unknown) =>
  NextResponse.json(
    {
      error: {
        code,
        message,
        ...(fieldErrors ? { fieldErrors } : {}),
      },
    },
    { status },
  );

/** POST /api/me/notifications/read - { updated, unreadCount }. */
export async function POST(request: Request) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) return errorEnvelope("unauthenticated", 401, "Sign in to manage your notifications.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorEnvelope("validation_error", 400, "Request body must be JSON.");
  }
  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope("validation_error", 400, "Invalid body.", parsed.error.flatten().fieldErrors);
  }

  const result = await markMineRead(identity.userId, parsed.data);
  const unreadCount = await countMyUnread(identity.userId);
  return NextResponse.json({ updated: result, unreadCount });
}
