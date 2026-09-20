import { createDrizzleAudienceRepository } from "@stratifit/audience";
import type { NotificationView } from "@stratifit/audience";

/**
 * Audience-private in-app notifications for the Media BFF (Stage 2.18,
 * D2.18-SELECT, D2.18-N1..N5).
 *
 * The repository is the SAME public-safe audience module used by
 * lib/content.ts and lib/progress.ts - Media never imports the database or
 * any internal service. The owner is ALWAYS the server-derived audience
 * identity resolved from the authenticated session (lib/identity.ts); no
 * client-supplied user/org authority ever reaches this module. Reads and
 * mark-read are owner-scoped; unread is the DERIVED count (D2.18-N5);
 * no rate limiting (frozen); no audit on owner commands (D2.14-2).
 */
const repository = createDrizzleAudienceRepository({
  databaseUrl: process.env.DATABASE_URL as string,
});

/** Owner-scoped feed, newest first. */
export const listMyNotifications = (audienceUserId: string, limit = 50) =>
  repository.listNotificationsByUser(audienceUserId, limit);

/** D2.18-N5: derived unread count for the owner. */
export const countMyUnread = (audienceUserId: string) =>
  repository.countUnreadByUser(audienceUserId);

/** D2.18-P2: mark read (all | ids); only the owner's NULL-read_at rows move. */
export const markMineRead = (
  audienceUserId: string,
  input: { all: true } | { ids: readonly string[] },
) => repository.markNotificationsRead(audienceUserId, input);

/**
 * Whitelisted BFF view (D2.18 freeze): notificationRef (opaque owner-scoped
 * addressing), kind, sourceRef (owner-scoped conversation ref), title, body,
 * readAt, createdAt. eventId / orgId / audienceUserId / audit metadata are
 * structurally ABSENT from this shape.
 */
export const toNotificationView = (row: {
  id: string;
  kind: string;
  sourceRef: string | null;
  title: string;
  body: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationView => ({
  notificationRef: row.id,
  kind: row.kind as NotificationView["kind"],
  ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}),
  title: row.title,
  ...(row.body ? { body: row.body } : {}),
  readAt: row.readAt ? row.readAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
});
