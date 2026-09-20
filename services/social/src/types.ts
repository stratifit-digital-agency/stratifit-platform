/**
 * Social-domain service types (Stage 2.15, D2.15-1..D2.15-6).
 *
 * services/social owns the five-family SOCIAL GRAPH (DM section 22, bounded
 * context 13): LIKE, SAVE, FOLLOW, COMMENT, SHARE. Every aggregate is
 * audience-owner state over PUBLISHED public content and audience identities
 * only — never production internals (invariant 13).
 *
 * HARD BOUNDARIES:
 *  - D2.15-3: NO social.* events exist; the taxonomy stays at exactly 34
 *    names. Writes are synchronous commands; notifications/analytics will
 *    consume facts when those contexts exist.
 *  - principal.userId is ALWAYS the server-derived audience identity; no
 *    caller-supplied user/org authority participates anywhere.
 *  - D2.15-2: follow = tombstone (deleted_at); like/save = hard-delete
 *    toggles; share = immutable fact (no update path exists).
 *  - D2.15-4: comment visibility is visible|hidden|removed; PUBLIC reads
 *    expose ONLY visible comments on published content; creation is
 *    email-gated (authorizeAudienceAction, packages/auth — unchanged).
 *  - D2.15-1: creator-profile follow targets are structurally supported
 *    (kind enum) but FAIL CLOSED until People is durable.
 */
import type { SocialCapabilityAction } from "@stratifit/auth";

/** DB CHECK mirrors: narrow enums (D2.15-6 for share channels). */
export const SHARE_CHANNELS = ["copy_link", "external"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export type CommentVisibility = "visible" | "hidden" | "removed";

export type FolloweeKind = "audience_user" | "creator_profile";

/** Comment body length limit (DB CHECK mirrors: char_length between 1 and 2000). */
export const COMMENT_BODY_MAX = 2000;

// ---------------------------------------------------------------------------
// Records (service-internal; never cross the public API unwrapped)
// ---------------------------------------------------------------------------

export interface LikeRecord {
  readonly audienceUserId: string;
  readonly contentRef: string;
  readonly createdAt: Date;
}

export interface SaveRecord {
  readonly audienceUserId: string;
  readonly contentRef: string;
  readonly createdAt: Date;
}

export interface FollowRecord {
  readonly id: string;
  readonly followerId: string;
  readonly followeeKind: FolloweeKind;
  readonly followeeAudienceUserId: string | null;
  readonly followeeCreatorProfileRef: string | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CommentRecord {
  readonly id: string;
  readonly orgId: string;
  readonly authorId: string;
  readonly contentRef: string;
  readonly parentCommentId: string | null;
  readonly body: string;
  readonly visibility: CommentVisibility;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ShareRecord {
  readonly audienceUserId: string;
  readonly contentRef: string;
  readonly channel: ShareChannel;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Public-safe views (whitelist — the ONLY shapes Media sees)
// ---------------------------------------------------------------------------

/** Own-state like/save view: the opaque contentRef only. */
export interface ContentRefView {
  readonly contentRef: string;
  readonly createdAt: string;
}

/** Own-state follow view. Creator followees are fail-closed upstream. */
export interface FollowView {
  readonly followeeRef: string;
  readonly followeeKind: FolloweeKind;
  readonly followedAt: string;
}

/** PUBLIC comment view: no author identity beyond the display handle. */
export interface PublicCommentView {
  readonly commentId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly parentCommentId: string | null;
  /** Server-resolved public display handle of the author (never a raw id). */
  readonly authorHandle: string;
}

// ---------------------------------------------------------------------------
// Command results (house style: discriminated, never throws)
// ---------------------------------------------------------------------------

export type SocialErrorReason =
  | "unauthenticated"
  | "email_verification_required"
  | "content_not_found"
  | "invalid_channel"
  | "invalid_body"
  | "self_follow"
  | "creator_targets_unsupported"
  | "parent_not_found"
  | "user_not_found";

export type SocialCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly reason: SocialErrorReason; readonly message: string } };

export const ok = <T>(value: T): SocialCommandResult<T> => ({ ok: true, value });
export const err = <T>(reason: SocialErrorReason, message: string): SocialCommandResult<T> => ({
  ok: false,
  error: { reason, message },
});

// ---------------------------------------------------------------------------
// Repository port (implemented by the Drizzle adapter in repository.ts)
// ---------------------------------------------------------------------------

export interface SocialRepository {
  /** Published content lookup (target eligibility: published-only). */
  findPublishedContentById(
    contentRef: string,
  ): Promise<{ readonly id: string; readonly orgId: string } | null>;
  /** Audience users (owner + followee resolution). */
  findAudienceUserById(
    audienceUserId: string,
  ): Promise<{
    readonly id: string;
    readonly orgId: string;
    readonly handle: string | null;
  } | null>;
  findAudienceUsersByIds(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  // likes (hard-delete toggle)
  findLike(audienceUserId: string, contentRef: string): Promise<LikeRecord | null>;
  insertLike(input: { orgId: string; audienceUserId: string; contentRef: string }): Promise<LikeRecord>;
  deleteLike(audienceUserId: string, contentRef: string): Promise<boolean>;
  listLikesByUser(audienceUserId: string, limit: number): Promise<readonly LikeRecord[]>;
  // saves (hard-delete toggle)
  findSave(audienceUserId: string, contentRef: string): Promise<SaveRecord | null>;
  insertSave(input: { orgId: string; audienceUserId: string; contentRef: string }): Promise<SaveRecord>;
  deleteSave(audienceUserId: string, contentRef: string): Promise<boolean>;
  listSavesByUser(audienceUserId: string, limit: number): Promise<readonly SaveRecord[]>;
  // follows (tombstone)
  findFollowAnyState(
    followerId: string,
    followeeKind: FolloweeKind,
    followeeRef: string,
  ): Promise<FollowRecord | null>;
  insertFollow(input: {
    orgId: string;
    followerId: string;
    followeeKind: FolloweeKind;
    followeeAudienceUserId: string | null;
    followeeCreatorProfileRef: string | null;
  }): Promise<FollowRecord>;
  /** Reactivation = clear the tombstone on the EXISTING row. */
  reactivateFollow(followId: string): Promise<FollowRecord>;
  setFollowDeleted(followId: string, deletedAt: Date | null): Promise<FollowRecord>;
  listActiveFollowsByFollower(followerId: string, limit: number): Promise<readonly FollowRecord[]>;
  // comments
  insertComment(input: {
    orgId: string;
    authorId: string;
    contentRef: string;
    parentCommentId: string | null;
    body: string;
  }): Promise<CommentRecord>;
  findVisibleCommentById(commentId: string): Promise<CommentRecord | null>;
  /** PUBLIC query: visible-only, oldest-first, on one content ref. */
  listVisibleComments(
    contentRef: string,
    limit: number,
  ): Promise<readonly CommentRecord[]>;
  // shares (immutable facts)
  insertShare(input: {
    orgId: string;
    audienceUserId: string;
    contentRef: string;
    channel: ShareChannel;
  }): Promise<ShareRecord>;
  listSharesByUser(audienceUserId: string, limit: number): Promise<readonly ShareRecord[]>;
}

// ---------------------------------------------------------------------------
// Service ports
// ---------------------------------------------------------------------------

/**
 * The server-derived audience principal. BOTH fields come from the
 * authenticated session resolved by services/identity (userId from the JIT-
 * provisioned audience_users row; emailVerified from the authoritative
 * server-side mirror) — no caller-supplied user/org/verification authority
 * is ever accepted.
 */
export interface SocialPrincipal {
  readonly userId: string;
  readonly emailVerified: boolean;
}

export interface SocialServiceDeps {
  readonly repository: SocialRepository;
  /**
   * Stage 2.16 (D2.16-5): narrow read-only creator-follow port over People.
   * OPTIONAL at the type level for backward compatibility with existing
   * compositions, but REQUIRED for creator_profile follow targets — when
   * absent, creator targets keep the Stage 2.15 fail-closed behavior
   * (creator_targets_unsupported). No new Social table, no Social events.
   */
  readonly creatorFollowPort?: {
    findActiveProfileById(
      profileId: string,
    ): Promise<{ readonly id: string; readonly orgId: string; readonly handle: string } | null>;
  };
}

export interface ToggleInput {
  readonly contentRef: string;
}

export interface FollowInput {
  readonly followeeKind: FolloweeKind;
  /** Required iff followeeKind = audience_user; required (any uuid) for creator_profile. */
  readonly followeeRef: string;
}

export interface CommentInput {
  readonly contentRef: string;
  readonly body: string;
  readonly parentCommentId?: string | null;
}

export interface ShareInput {
  readonly contentRef: string;
  readonly channel: ShareChannel;
}

export interface ListInput {
  readonly limit?: number;
}

/** like/save result: created for a fresh insert, removed for a delete toggle. */
export type ToggleOutcome =
  | { readonly kind: "liked"; readonly contentRef: string }
  | { readonly kind: "unliked"; readonly contentRef: string }
  | { readonly kind: "saved"; readonly contentRef: string }
  | { readonly kind: "unsaved"; readonly contentRef: string };

export type FollowOutcome =
  | { readonly kind: "following"; readonly followeeRef: string }
  | { readonly kind: "unfollowed"; readonly followeeRef: string };

export type CommentOutcome =
  | { readonly kind: "commented"; readonly commentId: string }
  | { readonly kind: "shared" ; readonly shareId: string };

export interface SocialService {
  /** like → liked; duplicate like is an idempotent no-op (liked). */
  like(
    principal: SocialPrincipal,
    input: ToggleInput,
  ): Promise<SocialCommandResult<ToggleOutcome>>;
  /** unlike → unliked; unlike of a non-existent like is an idempotent no-op. */
  unlike(
    principal: SocialPrincipal,
    input: ToggleInput,
  ): Promise<SocialCommandResult<ToggleOutcome>>;
  save(principal: SocialPrincipal, input: ToggleInput): Promise<SocialCommandResult<ToggleOutcome>>;
  unsave(principal: SocialPrincipal, input: ToggleInput): Promise<SocialCommandResult<ToggleOutcome>>;
  /** D2.15-2: tombstone semantics — re-follow reactivates the same row. */
  follow(principal: SocialPrincipal, input: FollowInput): Promise<SocialCommandResult<FollowOutcome>>;
  unfollow(
    principal: SocialPrincipal,
    input: FollowInput,
  ): Promise<SocialCommandResult<FollowOutcome>>;
  /** Email-gated (D2.15-4); threading only under visible parents. */
  comment(
    principal: SocialPrincipal,
    input: CommentInput,
  ): Promise<SocialCommandResult<CommentOutcome>>;
  /** Email-gated; immutable fact (duplicates are distinct rows). */
  share(
    principal: SocialPrincipal,
    input: ShareInput,
  ): Promise<SocialCommandResult<CommentOutcome>>;
  // Own-state reads (owner-scoped, server-derived user only)
  listLikes(principal: SocialPrincipal, query?: ListInput): Promise<readonly ContentRefView[]>;
  listSaves(principal: SocialPrincipal, query?: ListInput): Promise<readonly ContentRefView[]>;
  listFollows(principal: SocialPrincipal, query?: ListInput): Promise<readonly FollowView[]>;
  listShares(principal: SocialPrincipal, query?: ListInput): Promise<readonly ContentRefView[]>;
  /** Public visible-comments read (published content; anonymous callers OK). */
  listPublicComments(
    contentRef: string,
    query?: ListInput,
  ): Promise<SocialCommandResult<readonly PublicCommentView[]>>;
}

/** Re-exported for composition roots that gate before calling the service. */
export type { SocialCapabilityAction };
