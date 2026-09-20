/**
 * Unit tests for the SOCIAL GRAPH service (Stage 2.15, D2.15-1..6).
 *
 * Covers the approved matrix: like/save toggles (create/duplicate/unlike/
 * re-like), follow tombstone lifecycle (create/duplicate/unfollow/re-follow,
 * self-follow rejection, creator fail-closed), comments (email gate, body
 * limits, threading under visible parents only), shares (email gate, channel
 * enum, immutable facts), own-state reads, published-only eligibility, and
 * the public visible-comments projection. The fake repository mirrors the
 * real adapter semantics (uniques fire, tombstone states) without a DB.
 */
import { describe, expect, it } from "vitest";
import { createSocialService } from "./service";
import { socialReaderFromRepository } from "./public";
import type {
  CommentRecord,
  FollowRecord,
  SocialCommandResult,
  SocialPrincipal,
  SocialRepository,
} from "./types";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const verified: SocialPrincipal = { userId: uuid(1), emailVerified: true };
const unverified: SocialPrincipal = { userId: uuid(1), emailVerified: false };
const otherUser: SocialPrincipal = { userId: uuid(2), emailVerified: true };

/** Fake repository mirroring the real adapter semantics. */
class FakeRepo implements SocialRepository {
  likes = new Map<string, { orgId: string; audienceUserId: string; contentRef: string; createdAt: Date }>();
  saves = new Map<string, { orgId: string; audienceUserId: string; contentRef: string; createdAt: Date }>();
  follows = new Map<string, { id: string; followerId: string; followeeKind: "audience_user" | "creator_profile"; followeeAudienceUserId: string | null; followeeCreatorProfileRef: string | null; deletedAt: Date | null; createdAt: Date; updatedAt: Date }>();
  comments: Array<{ id: string; orgId: string; authorId: string; contentRef: string; parentCommentId: string | null; body: string; visibility: "visible" | "hidden" | "removed"; createdAt: Date; updatedAt: Date }> = [];
  shares: Array<{ audienceUserId: string; contentRef: string; channel: string; createdAt: Date }> = [];
  publishedContent = new Set<string>([uuid(100), uuid(101)]);
  users = new Map<string, { id: string; orgId: string; handle: string | null; status: string }>([
    [uuid(1), { id: uuid(1), orgId: uuid(10), handle: "alice", status: "active" }],
    [uuid(2), { id: uuid(2), orgId: uuid(10), handle: "bob", status: "active" }],
    [uuid(3), { id: uuid(3), orgId: uuid(11), handle: "carol", status: "active" }],
  ]);
  private seq = 500;

  nextId() {
    this.seq += 1;
    return uuid(this.seq);
  }

  key(a: string, b: string) {
    return `${a}|${b}`;
  }

  findPublishedContentById = async (contentRef: string) =>
    this.publishedContent.has(contentRef) ? { id: contentRef, orgId: uuid(10) } : null;

  findAudienceUserById = async (id: string) => {
    const u = this.users.get(id);
    return u && u.status === "active" ? { id: u.id, orgId: u.orgId, handle: u.handle } : null;
  };

  findAudienceUsersByIds = async (ids: readonly string[]) => {
    const m = new Map<string, string>();
    for (const id of ids) {
      const h = this.users.get(id)?.handle;
      if (h) m.set(id, h);
    }
    return m;
  };

  findLike = async (u: string, c: string) => this.likes.get(this.key(u, c)) ?? null;
  insertLike = async (input: { orgId: string; audienceUserId: string; contentRef: string }) => {
    const k = this.key(input.audienceUserId, input.contentRef);
    if (this.likes.has(k)) throw new Error("unique violation: likes_user_content_unique");
    const row = { ...input, createdAt: new Date() };
    this.likes.set(k, row);
    return { audienceUserId: row.audienceUserId, contentRef: row.contentRef, createdAt: row.createdAt };
  };
  deleteLike = async (u: string, c: string) => this.likes.delete(this.key(u, c));
  listLikesByUser = async (u: string, limit: number) =>
    [...this.likes.values()].filter((r) => r.audienceUserId === u).slice(0, limit);

  findSave = async (u: string, c: string) => this.saves.get(this.key(u, c)) ?? null;
  insertSave = async (input: { orgId: string; audienceUserId: string; contentRef: string }) => {
    const k = this.key(input.audienceUserId, input.contentRef);
    if (this.saves.has(k)) throw new Error("unique violation: saves_user_content_unique");
    const row = { ...input, createdAt: new Date() };
    this.saves.set(k, row);
    return { audienceUserId: row.audienceUserId, contentRef: row.contentRef, createdAt: row.createdAt };
  };
  deleteSave = async (u: string, c: string) => this.saves.delete(this.key(u, c));
  listSavesByUser = async (u: string, limit: number) =>
    [...this.saves.values()].filter((r) => r.audienceUserId === u).slice(0, limit);

  findFollowAnyState = async (followerId: string, kind: string, ref: string) => {
    for (const f of this.follows.values()) {
      if (
        f.followerId === followerId &&
        f.followeeKind === kind &&
        (kind === "audience_user" ? f.followeeAudienceUserId === ref : f.followeeCreatorProfileRef === ref)
      ) {
        return f;
      }
    }
    return null;
  };
  insertFollow = async (input: {
    orgId: string;
    followerId: string;
    followeeKind: "audience_user" | "creator_profile";
    followeeAudienceUserId: string | null;
    followeeCreatorProfileRef: string | null;
  }) => {
    const row: FollowRecord = {
      id: this.nextId(),
      followerId: input.followerId,
      followeeKind: input.followeeKind,
      followeeAudienceUserId: input.followeeAudienceUserId,
      followeeCreatorProfileRef: input.followeeCreatorProfileRef,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.follows.set(row.id, row);
    return row;
  };
  reactivateFollow = async (id: string) => {
    const row = this.follows.get(id)!;
    row.deletedAt = null;
    row.updatedAt = new Date();
    return row;
  };
  setFollowDeleted = async (id: string, deletedAt: Date | null) => {
    const row = this.follows.get(id)!;
    row.deletedAt = deletedAt;
    row.updatedAt = new Date();
    return row;
  };
  listActiveFollowsByFollower = async (followerId: string, limit: number) =>
    [...this.follows.values()]
      .filter((f) => f.followerId === followerId && f.deletedAt === null)
      .slice(0, limit);

  insertComment = async (input: {
    orgId: string;
    authorId: string;
    contentRef: string;
    parentCommentId: string | null;
    body: string;
  }) => {
    const row: CommentRecord = {
      id: this.nextId(),
      orgId: input.orgId,
      authorId: input.authorId,
      contentRef: input.contentRef,
      parentCommentId: input.parentCommentId,
      body: input.body,
      visibility: "visible",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.comments.push(row);
    return row;
  };
  findVisibleCommentById = async (id: string) =>
    this.comments.find((c) => c.id === id && c.visibility === "visible") ?? null;
  listVisibleComments = async (contentRef: string, limit: number) =>
    this.comments.filter((c) => c.contentRef === contentRef && c.visibility === "visible").slice(0, limit);

  insertShare = async (input: { orgId: string; audienceUserId: string; contentRef: string; channel: "copy_link" | "external" }) => {
    const row = { ...input, createdAt: new Date() };
    this.shares.push(row);
    return row;
  };
  listSharesByUser = async (u: string, limit: number) =>
    this.shares
      .filter((s) => s.audienceUserId === u)
      .slice(0, limit)
      .map((s) => ({ ...s, channel: s.channel as "copy_link" | "external" }));
}

const CONTENT = uuid(100);
const OTHER = uuid(101);
const UNPUBLISHED = uuid(999);

/** Hide a comment (moderation seam simulation). */
const hideComment = (repo: FakeRepo, id: string, visibility: "hidden" | "removed") => {
  const c = repo.comments.find((x) => x.id === id);
  if (c) c.visibility = visibility;
};

const expectOk = <T>(r: SocialCommandResult<T>): T => {
  expect(r.ok).toBe(true);
  return (r as { ok: true; value: T }).value;
};
const expectErr = <T>(r: SocialCommandResult<T>, reason: string) => {
  expect(r.ok).toBe(false);
  expect((r as { ok: false; error: { reason: string } }).error.reason).toBe(reason);
};

describe("likes (hard-delete toggle, D2.15-2)", () => {
  it("create → liked; duplicate like is an idempotent no-op (one row)", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.like(verified, { contentRef: CONTENT }));
    expectOk(await svc.like(verified, { contentRef: CONTENT }));
    expect(repo.likes.size).toBe(1);
  });

  it("unlike removes the row; re-like creates a fresh active relationship", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.like(verified, { contentRef: CONTENT }));
    const before = (repo.likes.get(repo.key(verified.userId, CONTENT))!).createdAt;
    expectOk(await svc.unlike(verified, { contentRef: CONTENT }));
    expect(repo.likes.size).toBe(0);
    expectOk(await svc.like(verified, { contentRef: CONTENT }));
    const after = repo.likes.get(repo.key(verified.userId, CONTENT))!.createdAt;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("unlike of a non-existent like is an idempotent no-op", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.unlike(verified, { contentRef: CONTENT }));
    expect(repo.likes.size).toBe(0);
  });

  it("published-only eligibility: unknown/unpublished content rejected", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectErr(await svc.like(verified, { contentRef: UNPUBLISHED }), "content_not_found");
    expectErr(await svc.like(verified, { contentRef: "not-a-uuid" }), "content_not_found");
  });
});

describe("saves (hard-delete toggle, D2.15-2)", () => {
  it("create → saved; duplicate save is an idempotent no-op; unsave removes; re-save works", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.save(verified, { contentRef: CONTENT }));
    expectOk(await svc.save(verified, { contentRef: CONTENT }));
    expect(repo.saves.size).toBe(1);
    expectOk(await svc.unsave(verified, { contentRef: CONTENT }));
    expect(repo.saves.size).toBe(0);
    expectOk(await svc.save(verified, { contentRef: CONTENT }));
    expect(repo.saves.size).toBe(1);
  });

  it("cross-user isolation: A's save never touches B's row", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.save(verified, { contentRef: CONTENT }));
    expectOk(await svc.save(otherUser, { contentRef: CONTENT }));
    expect(repo.saves.size).toBe(2);
    expectOk(await svc.unsave(verified, { contentRef: CONTENT }));
    expect(repo.saves.size).toBe(1);
    expect(repo.saves.has(repo.key(otherUser.userId, CONTENT))).toBe(true);
  });
});

describe("follows (tombstone lifecycle, D2.15-1/2)", () => {
  it("follow → active row; duplicate follow keeps one active row", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expectOk(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expect([...repo.follows.values()].filter((f) => f.deletedAt === null)).toHaveLength(1);
  });

  it("unfollow tombstones (row preserved, deleted_at set); re-follow REACTIVATES the same row", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    const originalId = [...repo.follows.values()][0]!.id;
    expectOk(await svc.unfollow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    const tombstoned = repo.follows.get(originalId)!;
    expect(tombstoned.deletedAt).not.toBeNull();
    expectOk(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    // Same row reactivated — never a second row.
    expect(repo.follows.size).toBe(1);
    expect(repo.follows.get(originalId)!.deletedAt).toBeNull();
  });

  it("repeated unfollow is an idempotent no-op; unfollow of never-followed works", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.unfollow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expectOk(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expectOk(await svc.unfollow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expectOk(await svc.unfollow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expect([...repo.follows.values()].filter((f) => f.deletedAt === null)).toHaveLength(0);
  });

  it("self-follow is rejected", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectErr(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: verified.userId }), "self_follow");
  });

  it("creator-profile targets FAIL CLOSED without a People port (legacy compositions) — no row is invented", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectErr(
      await svc.follow(verified, { followeeKind: "creator_profile", followeeRef: uuid(77) }),
      "creator_targets_unsupported",
    );
    expect(repo.follows.size).toBe(0);
  });

  // Stage 2.16 (D2.16-5): with the narrow People follow port wired, creator
  // follows become executable against ACTIVE profiles only.
  it("creator follow works against an ACTIVE profile; duplicate keeps one row (D2.16-5)", async () => {
    const repo = new FakeRepo();
    const profileId = uuid(77);
    const svc = createSocialService({
      repository: repo,
      creatorFollowPort: { findActiveProfileById: async (id) => (id === profileId ? { id, orgId: "org-1", handle: "ava" } : null) },
    });
    expectOk(await svc.follow(verified, { followeeKind: "creator_profile", followeeRef: profileId }));
    expectOk(await svc.follow(verified, { followeeKind: "creator_profile", followeeRef: profileId }));
    const rows = [...repo.follows.values()].filter((f) => f.followeeKind === "creator_profile" && f.deletedAt === null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.followeeCreatorProfileRef).toBe(profileId);
  });

  it("creator follow of a NONEXISTENT or INACTIVE profile fails closed; no row", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({
      repository: repo,
      creatorFollowPort: { findActiveProfileById: async () => null },
    });
    expectErr(await svc.follow(verified, { followeeKind: "creator_profile", followeeRef: uuid(78) }), "parent_not_found");
    expect(repo.follows.size).toBe(0);
  });

  it("creator unfollow tombstones; re-follow reactivates the SAME row (D2.15-2 preserved)", async () => {
    const repo = new FakeRepo();
    const profileId = uuid(79);
    const svc = createSocialService({
      repository: repo,
      creatorFollowPort: { findActiveProfileById: async (id) => (id === profileId ? { id, orgId: "org-1", handle: "ava" } : null) },
    });
    expectOk(await svc.follow(verified, { followeeKind: "creator_profile", followeeRef: profileId }));
    const originalId = [...repo.follows.values()][0]!.id;
    expectOk(await svc.unfollow(verified, { followeeKind: "creator_profile", followeeRef: profileId }));
    expect(repo.follows.get(originalId)!.deletedAt).not.toBeNull();
    expectOk(await svc.follow(verified, { followeeKind: "creator_profile", followeeRef: profileId }));
    expect(repo.follows.size).toBe(1);
    expect(repo.follows.get(originalId)!.deletedAt).toBeNull();
  });

  it("asymmetry: A→B does not create B→A", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expect([...repo.follows.values()]).toHaveLength(1);
    expect(repo.follows.values().next().value!.followerId).toBe(verified.userId);
  });

  it("followee must exist and be active (fail closed)", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectErr(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(42) }), "parent_not_found");
  });
});

describe("comments (email gate + visibility, D2.15-4)", () => {
  it("email-unverified authors are rejected with email_verification_required", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectErr(
      await svc.comment(unverified, { contentRef: CONTENT, body: "hello" }),
      "email_verification_required",
    );
    expect(repo.comments).toHaveLength(0);
  });

  it("verified comment is created visible and recorded", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    const out = expectOk(await svc.comment(verified, { contentRef: CONTENT, body: "great film" }));
    expect(out.kind).toBe("commented");
    expect(repo.comments[0]!.visibility).toBe("visible");
  });

  it("body limits: empty/whitespace and >2000 chars rejected", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectErr(await svc.comment(verified, { contentRef: CONTENT, body: "" }), "invalid_body");
    expectErr(await svc.comment(verified, { contentRef: CONTENT, body: "   " }), "invalid_body");
    expectErr(await svc.comment(verified, { contentRef: CONTENT, body: "x".repeat(2001) }), "invalid_body");
    expectOk(await svc.comment(verified, { contentRef: CONTENT, body: "x".repeat(2000) }));
  });

  it("threading: replies require a VISIBLE parent on the SAME content", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    const parent = expectOk(await svc.comment(verified, { contentRef: CONTENT, body: "root" }));
    const reply = expectOk(
      await svc.comment(otherUser, {
        contentRef: CONTENT,
        body: "reply",
        parentCommentId: (parent as { commentId: string }).commentId,
      }),
    );
    expect((reply as { commentId: string }).commentId).toBeDefined();

    // Hidden parent cannot gain replies.
    hideComment(repo, (parent as { commentId: string }).commentId, "hidden");
    expectErr(
      await svc.comment(otherUser, {
        contentRef: CONTENT,
        body: "reply2",
        parentCommentId: (parent as { commentId: string }).commentId,
      }),
      "parent_not_found",
    );
    // Removed parent — same fail-closed result.
    hideComment(repo, (parent as { commentId: string }).commentId, "removed");
    expectErr(
      await svc.comment(otherUser, {
        contentRef: CONTENT,
        body: "reply3",
        parentCommentId: (parent as { commentId: string }).commentId,
      }),
      "parent_not_found",
    );
    // Parent on a DIFFERENT content ref is rejected.
    const parentOther = expectOk(await svc.comment(verified, { contentRef: OTHER, body: "elsewhere" }));
    expectErr(
      await svc.comment(otherUser, {
        contentRef: CONTENT,
        body: "cross",
        parentCommentId: (parentOther as { commentId: string }).commentId,
      }),
      "parent_not_found",
    );
  });
});

describe("shares (email gate + channel enum + immutable facts, D2.15-6)", () => {
  it("email-unverified authors are rejected", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectErr(await svc.share(unverified, { contentRef: CONTENT, channel: "copy_link" }), "email_verification_required");
    expect(repo.shares).toHaveLength(0);
  });

  it("allowed channels are copy_link and external; others rejected", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.share(verified, { contentRef: CONTENT, channel: "copy_link" }));
    expectOk(await svc.share(verified, { contentRef: CONTENT, channel: "external" }));
    expectErr(
      await svc.share(verified, { contentRef: CONTENT, channel: "carrier-pigeon" as never }),
      "invalid_channel",
    );
  });

  it("shares are immutable facts: duplicate (user, content, channel) creates a DISTINCT row", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.share(verified, { contentRef: CONTENT, channel: "copy_link" }));
    expectOk(await svc.share(verified, { contentRef: CONTENT, channel: "copy_link" }));
    expect(repo.shares).toHaveLength(2);
  });
});

describe("own-state reads (owner-scoped)", () => {
  it("list likes/saves/follows/shares return only the caller's rows, tombstones excluded", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectOk(await svc.like(verified, { contentRef: CONTENT }));
    expectOk(await svc.like(otherUser, { contentRef: OTHER }));
    expectOk(await svc.save(verified, { contentRef: OTHER }));
    expectOk(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expectOk(await svc.share(verified, { contentRef: CONTENT, channel: "external" }));

    const likes = await svc.listLikes(verified);
    expect(likes).toHaveLength(1);
    expect(likes[0]!.contentRef).toBe(CONTENT);
    expect(Object.keys(likes[0]!).sort()).toEqual(["contentRef", "createdAt"]);

    const saves = await svc.listSaves(verified);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.contentRef).toBe(OTHER);

    expectOk(await svc.unfollow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    expect(await svc.listFollows(verified)).toHaveLength(0);
    expectOk(await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) }));
    const follows = await svc.listFollows(verified);
    expect(follows).toHaveLength(1);
    expect(follows[0]!.followeeRef).toBe(uuid(2));

    const shares = await svc.listShares(verified);
    expect(shares).toHaveLength(1);
  });

  it("limit clamping: below 1 → 1, above 200 → 200", async () => {
    const repo = new FakeRepo();
    for (let i = 0; i < 5; i++) repo.publishedContent.add(uuid(200 + i));
    const svc = createSocialService({ repository: repo });
    for (let i = 0; i < 5; i++) {
      expectOk(await svc.like(verified, { contentRef: uuid(200 + i) }));
    }
    expect(await svc.listLikes(verified, { limit: 2 })).toHaveLength(2);
    expect(await svc.listLikes(verified, { limit: 0 })).toHaveLength(1);
    expect(await svc.listLikes(verified, { limit: 5000 })).toHaveLength(5);
  });

  it("unknown user fails closed on writes (user_not_found)", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    const ghost: SocialPrincipal = { userId: uuid(999), emailVerified: true };
    expectErr(await svc.like(ghost, { contentRef: CONTENT }), "user_not_found");
    expectErr(await svc.follow(ghost, { followeeKind: "audience_user", followeeRef: uuid(2) }), "user_not_found");
  });
});

describe("public visible-comments read (D2.15-4)", () => {
  it("exposes ONLY visible comments on PUBLISHED content; hidden/removed excluded", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    const a = expectOk(await svc.comment(verified, { contentRef: CONTENT, body: "keep" }));
    const b = expectOk(await svc.comment(otherUser, { contentRef: CONTENT, body: "hide me" }));
    hideComment(repo, (b as { commentId: string }).commentId, "hidden");
    const c = expectOk(await svc.comment(otherUser, { contentRef: CONTENT, body: "remove me" }));
    hideComment(repo, (c as { commentId: string }).commentId, "removed");

    const views = expectOk(await svc.listPublicComments(CONTENT));
    expect(views).toHaveLength(1);
    expect(views[0]!.body).toBe("keep");
    expect(Object.keys(views[0]!).sort()).toEqual([
      "authorHandle",
      "body",
      "commentId",
      "createdAt",
      "parentCommentId",
    ]);
    expect(views[0]!.authorHandle).toBe("alice");
    void a;
  });

  it("unpublished/unknown content → content_not_found (no existence leak)", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    expectErr(await svc.listPublicComments(UNPUBLISHED), "content_not_found");
  });

  it("author display handle resolved; unknown handle falls back safely (never a raw id)", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    await svc.comment(verified, { contentRef: CONTENT, body: "hi" });
    const views = expectOk(await svc.listPublicComments(CONTENT));
    expect(JSON.stringify(views)).not.toContain(verified.userId);
  });
});

describe("public reader fragment (whitelist projections)", () => {
  it("socialReaderFromRepository maps likes/follows and refuses unpublished comment reads", async () => {
    const repo = new FakeRepo();
    const svc = createSocialService({ repository: repo });
    await svc.like(verified, { contentRef: CONTENT });
    await svc.follow(verified, { followeeKind: "audience_user", followeeRef: uuid(2) });
    const reader = socialReaderFromRepository(repo);
    const likes = await reader.listLikes(verified.userId);
    expect(likes).toHaveLength(1);
    const follows = await reader.listFollows(verified.userId);
    expect(follows[0]!.followeeRef).toBe(uuid(2));
    expect(await reader.listPublicComments(UNPUBLISHED)).toBeNull();
  });
});
