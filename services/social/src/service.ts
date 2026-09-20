/**
 * Social-domain service (Stage 2.15, D2.15-1..D2.15-6).
 *
 * Owner-scoped synchronous commands over the five-family social graph.
 * Every method:
 *  - derives ALL authority from the server-side principal (userId);
 *  - gates via the EXISTING pure rule `authorizeAudienceAction`
 *    (packages/auth, unchanged): comment/share require email verification,
 *    like/save/follow require authentication only;
 *  - verifies the target content exists and is PUBLISHED (published-only
 *    eligibility, matching the watch-progress rule);
 *  - never throws for domain failures (discriminated results).
 *
 * D2.15-3: no events are emitted anywhere — the taxonomy stays at 34.
 */
import { authorizeAudienceAction, type SocialCapabilityAction } from "@stratifit/auth";
import { COMMENT_BODY_MAX, SHARE_CHANNELS, err, ok } from "./types";
import type {
  CommentInput,
  CommentOutcome,
  ContentRefView,
  FollowInput,
  FollowOutcome,
  FollowView,
  ListInput,
  PublicCommentView,
  ShareInput,
  SocialCommandResult,
  SocialPrincipal,
  SocialRepository,
  SocialService,
  SocialServiceDeps,
  ToggleInput,
  ToggleOutcome,
} from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? 50, 1), 200);

/**
 * Authentication/verification gate through the UNCHANGED pure rule in
 * packages/auth. The principal's emailVerified flag is SERVER-DERIVED
 * (identity resolution), not a client field; the gate is identical to the
 * documented capability matrix: like/save/follow = authenticated, comment/
 * share = authenticated + email verified.
 */
const authorize = (
  principal: SocialPrincipal,
  action: SocialCapabilityAction,
): SocialCommandResult<void> => {
  const decision = authorizeAudienceAction(
    {
      kind: "audience",
      userId: principal.userId,
      email: "",
      emailVerified: principal.emailVerified,
    },
    action,
  );
  if (!decision.allowed) {
    return err(
      decision.reason === "email_verification_required"
        ? "email_verification_required"
        : "unauthenticated",
      decision.reason,
    );
  }
  return ok(undefined);
};

export const createSocialService = (deps: SocialServiceDeps): SocialService => {
  const repo = deps.repository;
  const creatorFollowPort = deps.creatorFollowPort;

  /** Owner context: the audience user's own org row (server-derived). */
  const ownerOf = async (
    principal: SocialPrincipal,
  ): Promise<SocialCommandResult<{ id: string; orgId: string; handle: string | null }>> => {
    const user = await repo.findAudienceUserById(principal.userId);
    if (!user) return err("user_not_found", "audience user does not exist or is not active");
    return ok(user);
  };

  /** Published-content eligibility shared by every aggregate. */
  const publishedTarget = async (contentRef: string) => {
    if (!UUID_RE.test(contentRef)) {
      return err("content_not_found", "contentRef must be a valid uuid");
    }
    const content = await repo.findPublishedContentById(contentRef);
    if (!content) return err("content_not_found", "no published public content for this contentRef");
    return ok(content);
  };

  const toggleLike = async (
    principal: SocialPrincipal,
    input: ToggleInput,
    on: boolean,
  ): Promise<SocialCommandResult<ToggleOutcome>> => {
    const gateResult = authorize(principal, "like");
    if (!gateResult.ok) return gateResult;
    const target = await publishedTarget(input.contentRef);
    if (!target.ok) return target;
    const owner = await ownerOf(principal);
    if (!owner.ok) return owner;

    if (on) {
      const existing = await repo.findLike(principal.userId, input.contentRef);
      if (!existing) {
        // UNIQUE is the final backstop; a lost race is still a like.
        await repo.insertLike({ orgId: owner.value.orgId, audienceUserId: principal.userId, contentRef: input.contentRef }).catch(() => undefined);
      }
      return ok({ kind: "liked", contentRef: input.contentRef });
    }
    await repo.deleteLike(principal.userId, input.contentRef);
    return ok({ kind: "unliked", contentRef: input.contentRef });
  };

  const toggleSave = async (
    principal: SocialPrincipal,
    input: ToggleInput,
    on: boolean,
  ): Promise<SocialCommandResult<ToggleOutcome>> => {
    const gateResult = authorize(principal, "save");
    if (!gateResult.ok) return gateResult;
    const target = await publishedTarget(input.contentRef);
    if (!target.ok) return target;
    const owner = await ownerOf(principal);
    if (!owner.ok) return owner;

    if (on) {
      const existing = await repo.findSave(principal.userId, input.contentRef);
      if (!existing) {
        await repo.insertSave({ orgId: owner.value.orgId, audienceUserId: principal.userId, contentRef: input.contentRef }).catch(() => undefined);
      }
      return ok({ kind: "saved", contentRef: input.contentRef });
    }
    await repo.deleteSave(principal.userId, input.contentRef);
    return ok({ kind: "unsaved", contentRef: input.contentRef });
  };

  return {
    like: (principal, input) => toggleLike(principal, input, true),
    unlike: (principal, input) => toggleLike(principal, input, false),
    save: (principal, input) => toggleSave(principal, input, true),
    unsave: (principal, input) => toggleSave(principal, input, false),

    async follow(principal, input) {
      const gateResult = authorize(principal, "follow");
      if (!gateResult.ok) return gateResult;
      const owner = await ownerOf(principal);
      if (!owner.ok) return owner;

      // Stage 2.16 (D2.16-5): creator-profile follow targets are now
      // EXECUTABLE against an ACTIVE creator_profiles row through the narrow
      // read-only People port. Fail-closed preserved: absent port (legacy
      // composition), nonexistent profile, or INACTIVE profile all fail
      // closed; the port resolves ACTIVE profiles only, and the row's org is
      // taken from the profile (org binding follows the owner — no client org).
      if (input.followeeKind === "creator_profile") {
        if (!creatorFollowPort) {
          return err("creator_targets_unsupported", "creator follows require the People bounded context");
        }
        if (!UUID_RE.test(input.followeeRef)) {
          return err("parent_not_found", "followeeRef must be a valid uuid");
        }
        const profile = await creatorFollowPort.findActiveProfileById(input.followeeRef);
        if (!profile) {
          return err("parent_not_found", "creator profile does not exist or is not active");
        }
        const existing = await repo.findFollowAnyState(principal.userId, "creator_profile", input.followeeRef);
        if (!existing) {
          await repo.insertFollow({
            orgId: owner.value.orgId,
            followerId: principal.userId,
            followeeKind: "creator_profile",
            followeeAudienceUserId: null,
            followeeCreatorProfileRef: profile.id,
          });
        } else if (existing.deletedAt !== null) {
          await repo.reactivateFollow(existing.id);
        }
        return ok({ kind: "following", followeeRef: input.followeeRef });
      }
      if (!UUID_RE.test(input.followeeRef)) {
        return err("parent_not_found", "followeeRef must be a valid uuid");
      }
      if (input.followeeRef === principal.userId) {
        return err("self_follow", "a user cannot follow themselves");
      }
      const followee = await repo.findAudienceUserById(input.followeeRef);
      if (!followee) return err("parent_not_found", "followee audience user does not exist or is not active");

      // D2.15-2: tombstone reactivation — find ANY-state row first.
      const existing = await repo.findFollowAnyState(principal.userId, "audience_user", input.followeeRef);
      if (!existing) {
        await repo.insertFollow({
          orgId: owner.value.orgId,
          followerId: principal.userId,
          followeeKind: "audience_user",
          followeeAudienceUserId: input.followeeRef,
          followeeCreatorProfileRef: null,
        });
      } else if (existing.deletedAt !== null) {
        await repo.reactivateFollow(existing.id);
      }
      return ok({ kind: "following", followeeRef: input.followeeRef });
    },

    async unfollow(principal, input) {
      const gateResult = authorize(principal, "follow");
      if (!gateResult.ok) return gateResult;
      const owner = await ownerOf(principal);
      if (!owner.ok) return owner;

      if (input.followeeKind === "creator_profile") {
        // D2.16-5: unfollow mirrors follow — tombstone the relationship row.
        // Never-followed or already-tombstoned targets are idempotent no-ops.
        if (!creatorFollowPort) {
          return err("creator_targets_unsupported", "creator follows require the People bounded context");
        }
        if (!UUID_RE.test(input.followeeRef)) {
          return err("parent_not_found", "followeeRef must be a valid uuid");
        }
        const existing = await repo.findFollowAnyState(principal.userId, "creator_profile", input.followeeRef);
        if (existing && existing.deletedAt === null) {
          await repo.setFollowDeleted(existing.id, new Date());
        }
        return ok({ kind: "unfollowed", followeeRef: input.followeeRef });
      }
      if (!UUID_RE.test(input.followeeRef)) {
        return err("parent_not_found", "followeeRef must be a valid uuid");
      }
      const existing = await repo.findFollowAnyState(principal.userId, "audience_user", input.followeeRef);
      // Unfollow of a never-followed (or already-tombstoned) target is an
      // idempotent no-op that still reports the unfollowed outcome.
      if (existing && existing.deletedAt === null) {
        await repo.setFollowDeleted(existing.id, new Date());
      }
      return ok({ kind: "unfollowed", followeeRef: input.followeeRef });
    },

    async comment(principal, input) {
      const gateResult = authorize(principal, "comment");
      if (!gateResult.ok) return gateResult;
      const target = await publishedTarget(input.contentRef);
      if (!target.ok) return target;
      const owner = await ownerOf(principal);
      if (!owner.ok) return owner;

      const body = input.body ?? "";
      if (typeof body !== "string" || body.trim().length === 0 || body.length > COMMENT_BODY_MAX) {
        return err("invalid_body", `body must be 1..${COMMENT_BODY_MAX} characters`);
      }

      let parentCommentId: string | null = null;
      if (input.parentCommentId) {
        if (!UUID_RE.test(input.parentCommentId)) {
          return err("parent_not_found", "parentCommentId must be a valid uuid");
        }
        const parent = await repo.findVisibleCommentById(input.parentCommentId);
        // D2.15-4: replies only under VISIBLE parents (hidden/removed parents
        // cannot gain new replies; unknown parents fail closed).
        if (!parent || parent.contentRef !== input.contentRef) {
          return err("parent_not_found", "parent comment is not visible on this content");
        }
        parentCommentId = parent.id;
      }

      const row = await repo.insertComment({
        orgId: owner.value.orgId,
        authorId: principal.userId,
        contentRef: input.contentRef,
        parentCommentId,
        body,
      });
      return ok<CommentOutcome>({ kind: "commented", commentId: row.id });
    },

    async share(principal, input) {
      const gateResult = authorize(principal, "share");
      if (!gateResult.ok) return gateResult;
      const target = await publishedTarget(input.contentRef);
      if (!target.ok) return target;
      const owner = await ownerOf(principal);
      if (!owner.ok) return owner;

      // D2.15-6: narrow channel CHECK — no free-form strings.
      if (!(SHARE_CHANNELS as readonly string[]).includes(input.channel)) {
        return err("invalid_channel", "channel must be copy_link or external");
      }
      const row = await repo.insertShare({
        orgId: owner.value.orgId,
        audienceUserId: principal.userId,
        contentRef: input.contentRef,
        channel: input.channel,
      });
      return ok<CommentOutcome>({ kind: "shared", shareId: row.contentRef });
    },

    async listLikes(principal, query) {
      const rows = await repo.listLikesByUser(principal.userId, clampLimit(query?.limit));
      const views: ContentRefView[] = rows.map((r) => ({
        contentRef: r.contentRef,
        createdAt: r.createdAt.toISOString(),
      }));
      return views;
    },

    async listSaves(principal, query) {
      const rows = await repo.listSavesByUser(principal.userId, clampLimit(query?.limit));
      const views: ContentRefView[] = rows.map((r) => ({
        contentRef: r.contentRef,
        createdAt: r.createdAt.toISOString(),
      }));
      return views;
    },

    async listFollows(principal, query) {
      const rows = await repo.listActiveFollowsByFollower(principal.userId, clampLimit(query?.limit));
      const views: FollowView[] = rows.map((r) => ({
        followeeRef: (r.followeeAudienceUserId ?? r.followeeCreatorProfileRef) as string,
        followeeKind: r.followeeKind,
        followedAt: r.createdAt.toISOString(),
      }));
      return views;
    },

    async listShares(principal, query) {
      const rows = await repo.listSharesByUser(principal.userId, clampLimit(query?.limit));
      const views: ContentRefView[] = rows.map((r) => ({
        contentRef: r.contentRef,
        createdAt: r.createdAt.toISOString(),
      }));
      return views;
    },

    async listPublicComments(contentRef, query) {
      if (!UUID_RE.test(contentRef)) {
        return err("content_not_found", "contentRef must be a valid uuid");
      }
      const target = await repo.findPublishedContentById(contentRef);
      if (!target) return err("content_not_found", "no published public content for this contentRef");
      const rows = await repo.listVisibleComments(contentRef, clampLimit(query?.limit));
      const handles = await repo.findAudienceUsersByIds(rows.map((r) => r.authorId));
      const views: PublicCommentView[] = rows.map((r) => ({
        commentId: r.id,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
        parentCommentId: r.parentCommentId,
        authorHandle: handles.get(r.authorId) ?? "member",
      }));
      return ok(views);
    },
  };
};
