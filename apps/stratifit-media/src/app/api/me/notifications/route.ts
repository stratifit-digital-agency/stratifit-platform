import { NextResponse } from "next/server";
import { z } from "zod";
import { countMyUnread, listMyNotifications, toNotificationView } from "@/lib/notifications";
import { resolveMediaIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * Audience-private notification feed (Stage 2.18, D2.18-SELECT).
 *
 * Server-side enforcement:
 *  - Identity is resolved from the authenticated session; ANONYMOUS OR
 *    NON-AUDIENCE CALLERS ARE REJECTED (401).
 *  - The owner is the SERVER-DERIVED audience identity; no client
 *    audienceUserId/orgId field is acceptable.
 *  - Responses expose ONLY the whitelist: notificationRef (opaque row id),
 *    kind, sourceRef (owner-scoped conversation ref), title, body, readAt,
 *    createdAt - plus the DERIVED unreadCount (D2.18-N5). No event ids, org
 *    ids, owner ids, actor/audit metadata, or internal fields.
 *  - Errors use the Section 13 envelope.
 *  - No rate limiting (frozen - reads only).
 */

const getQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

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

const unauthorized = () =>
  errorEnvelope("unauthenticated", 401, "Sign in to see your notifications.");

/** GET /api/me/notifications - owner-scoped feed + derived unread count. */
export async function GET(request: Request) {
  const identity = await resolveMediaIdentity(request);
  if (!identity) return unauthorized();

  const url = new URL(request.url);
  const parsedQuery = getQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsedQuery.success) {
    return errorEnvelope("validation_error", 400, "Invalid query.", parsedQuery.error.flatten().fieldErrors);
  }

  const [items, unreadCount] = await Promise.all([
    listMyNotifications(identity.userId, parsedQuery.data.limit),
    countMyUnread(identity.userId),
  ]);
  return NextResponse.json({
    items: items.map(toNotificationView),
    unreadCount,
  });
}
