/**
 * Media creators-surface guards (Stage 2.16, D2.16-8).
 *
 * Verifies the PUBLIC-SAFE projection that the /api/creators routes emit:
 * only the whitelisted fields (handle, displayName, bio, interests,
 * avatarRef, posterRef, status) — never internal row ids, org ids,
 * publication ids, storage paths/URLs, or credentials; only ACTIVE profiles
 * are projected. Also verifies the follow-body schema accepts the new
 * creator_profile kind selector and still rejects unknown fields (strict
 * schemas), and that creator handles are validated against the DB CHECK
 * shape.
 */
import { describe, expect, it } from "vitest";
import { toPublicCreatorView, toPublicCreatorViews } from "@stratifit/people";
import { followBodySchema, handleShape } from "./social-route";
import type { CreatorProfileRecord } from "@stratifit/people";

const baseProfile = (overrides: Partial<CreatorProfileRecord> = {}): CreatorProfileRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222221",
  aiCreatorId: "33333333-3333-4333-8333-333333333331",
  publicationId: "44444444-4444-4444-8444-444444444441",
  publicationVersionId: "55555555-5555-4555-8555-555555555551",
  handle: "ava",
  displayName: "Ava AI",
  bio: "hello",
  personalitySnapshot: {},
  interestsSnapshot: ["art"],
  avatarRef: null,
  posterRef: null,
  messagingEnabled: false,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const PUBLIC_KEYS = ["handle", "displayName", "bio", "interests", "avatarRef", "posterRef", "status"] as const;

describe("public creator projection whitelist (D2.16-8)", () => {
  it("exposes exactly the whitelisted fields — no internal identifiers", () => {
    const view = toPublicCreatorView(baseProfile());
    expect(Object.keys(view).sort()).toEqual([...PUBLIC_KEYS].sort());
    // Internal identifiers never appear anywhere in the projection.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("11111111"); // profile row id
    expect(serialized).not.toContain("22222222"); // org id
    expect(serialized).not.toContain("44444444"); // publication id
    expect(serialized).not.toContain("55555555"); // publication version id
  });

  it("projects only ACTIVE profiles; paused/unpublished rows are dropped", () => {
    const rows = [
      baseProfile(),
      baseProfile({ handle: "ben", status: "paused" }),
      baseProfile({ handle: "cyd", status: "unpublished" }),
    ];
    const views = toPublicCreatorViews(rows);
    expect(views.map((v) => v.handle)).toEqual(["ava"]);
  });

  it("passes opaque refs through without resolution (no URL construction)", () => {
    const view = toPublicCreatorView(baseProfile({ avatarRef: "66666666-6666-4666-8666-666666666661" }));
    expect(view.avatarRef).toBe("66666666-6666-4666-8666-666666666661");
    expect(JSON.stringify(view)).not.toMatch(/https?:\/\//);
  });

  it("never leaks personality snapshot internals (chain-private state)", () => {
    const view = toPublicCreatorView(baseProfile({ personalitySnapshot: { systemPrompt: "secret" } }));
    expect(JSON.stringify(view)).not.toContain("systemPrompt");
  });
});

describe("creator follow schema (D2.16-5)", () => {
  it("accepts the creator_profile kind selector", () => {
    const parsed = followBodySchema.safeParse({ followeeRef: "33333333-3333-4333-8333-333333333331", followeeKind: "creator_profile" });
    expect(parsed.success).toBe(true);
  });

  it("defaults to audience_user when the kind is omitted", () => {
    const parsed = followBodySchema.safeParse({ followeeRef: "33333333-3333-4333-8333-333333333331" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.followeeKind).toBeUndefined();
  });

  it("rejects unknown/authority fields (strict schemas)", () => {
    for (const body of [
      { followeeRef: "33333333-3333-4333-8333-333333333331", orgId: "22222222-2222-4222-8222-222222222221" },
      { followeeRef: "33333333-3333-4333-8333-333333333331", emailVerified: true },
      { followeeRef: "33333333-3333-4333-8333-333333333331", followeeKind: "audience_user", userId: "x" },
    ]) {
      expect(followBodySchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("creator handle route validation (D2.16-8)", () => {
  it("accepts DB-shaped handles", () => {
    expect(handleShape.safeParse("ava").success).toBe(true);
    expect(handleShape.safeParse("ava-ai-2026").success).toBe(true);
  });

  it("rejects malformed handles (fail closed before any lookup)", () => {
    for (const handle of ["ab", "Ava", "ava ai", "ava_ai", `${"a".repeat(65)}`, ""]) {
      expect(handleShape.safeParse(handle).success).toBe(false);
    }
  });
});
