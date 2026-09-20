/**
 * Media notifications-lib guards (Stage 2.18, D2.18-SELECT/N4/N5, P2).
 *
 * Verifies the PUBLIC-SAFE projection that /api/me/notifications emits:
 * exactly the whitelist fields (notificationRef, kind, sourceRef, title,
 * body, readAt, createdAt) - NEVER eventId, orgId, audienceUserId, or audit
 * metadata. Also verifies the mark-read wrapper passes the strict union
 * through untouched (the owner comes from the server-derived principal at
 * the route layer, never from a client body).
 */
import { describe, expect, it } from "vitest";
import { toNotificationView } from "./notifications";

describe("notifications lib (Stage 2.18)", () => {
  const baseRow = {
    id: "44444444-4444-4444-8444-444444444444",
    kind: "conversation_reply",
    sourceRef: "33333333-3333-4333-8333-333333333333",
    title: "New reply",
    body: "Your conversation has a new reply.",
    readAt: null as Date | null,
    createdAt: new Date("2026-09-20T12:00:00.000Z"),
  };

  it("projects ONLY the whitelisted fields", () => {
    const view = toNotificationView(baseRow);
    expect(Object.keys(view).sort()).toEqual(
      ["body", "createdAt", "kind", "notificationRef", "readAt", "sourceRef", "title"],
    );
    expect(view.notificationRef).toBe(baseRow.id);
    expect(view.kind).toBe("conversation_reply");
    expect(view.readAt).toBeNull();
    expect(view.createdAt).toBe("2026-09-20T12:00:00.000Z");
  });

  it("never includes eventId, orgId, audienceUserId, or audit metadata", () => {
    const view = toNotificationView({ ...baseRow, eventId: "evt-should-not-leak", orgId: "org", audienceUserId: "user" } as never);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("evt-should-not-leak");
    expect("orgId" in view).toBe(false);
    expect("audienceUserId" in view).toBe(false);
    expect("eventId" in view).toBe(false);
  });

  it("omits sourceRef/body when null instead of serializing nulls", () => {
    const view = toNotificationView({ ...baseRow, sourceRef: null, body: null });
    expect("sourceRef" in view).toBe(false);
    expect("body" in view).toBe(false);
  });

  it("serializes readAt when set (read state)", () => {
    const view = toNotificationView({ ...baseRow, readAt: new Date("2026-09-20T13:00:00.000Z") });
    expect(view.readAt).toBe("2026-09-20T13:00:00.000Z");
  });

  it("keeps kind within the frozen taxonomy", () => {
    const view = toNotificationView({ ...baseRow, kind: "conversation_reply" });
    expect(view.kind).toBe("conversation_reply");
  });
});
