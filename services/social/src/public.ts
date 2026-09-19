/**
 * Public-service fragment of the social module (Stage 2.15): the read API
 * Stratifit Media composes. This is the ONLY surface Media touches.
 *
 * SECURITY: whitelist projections are the enforcement point — raw records
 * NEVER cross this boundary. Own-state views carry the opaque contentRef;
 * public comment views carry the author's display HANDLE (never a raw user
 * id, never org identity).
 */
import type {
  ContentRefView,
  FollowView,
  LikeRecord,
  PublicCommentView,
  SaveRecord,
  ShareRecord,
  SocialRepository,
} from "./types";

export interface SocialReaderDeps {
  /** Server-derived audience user for own-state reads. */
  findAudienceUserById(
    audienceUserId: string,
  ): Promise<{
    readonly id: string;
    readonly orgId: string;
    readonly handle: string | null;
  } | null>;
  listLikesByUser(audienceUserId: string, limit: number): Promise<readonly LikeRecord[]>;
  listSavesByUser(audienceUserId: string, limit: number): Promise<readonly SaveRecord[]>;
  listActiveFollowsByFollower(followerId: string, limit: number): Promise<
    readonly {
      followeeKind: "audience_user" | "creator_profile";
      followeeAudienceUserId: string | null;
      followeeCreatorProfileRef: string | null;
      createdAt: Date;
      deletedAt: Date | null;
    }[]
  >;
  listSharesByUser(audienceUserId: string, limit: number): Promise<readonly ShareRecord[]>;
  findAudienceUsersByIds(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  listVisibleComments(contentRef: string, limit: number): Promise<
    readonly {
      id: string;
      authorId: string;
      body: string;
      parentCommentId: string | null;
      createdAt: Date;
    }[]
  >;
  findPublishedContentById(
    contentRef: string,
  ): Promise<{ readonly id: string; readonly orgId: string } | null>;
}

const toContentRefView = (r: { contentRef: string; createdAt: Date }): ContentRefView => ({
  contentRef: r.contentRef,
  createdAt: r.createdAt.toISOString(),
});

export const createSocialReader = (deps: SocialReaderDeps) => ({
  /** Owner-scoped like list (opaque contentRefs, newest first). */
  listLikes: async (audienceUserId: string, limit = 50): Promise<ContentRefView[]> => {
    const rows = await deps.listLikesByUser(audienceUserId, Math.min(Math.max(limit, 1), 200));
    return rows.map(toContentRefView);
  },
  /** Owner-scoped save list. */
  listSaves: async (audienceUserId: string, limit = 50): Promise<ContentRefView[]> => {
    const rows = await deps.listSavesByUser(audienceUserId, Math.min(Math.max(limit, 1), 200));
    return rows.map(toContentRefView);
  },
  /** Owner-scoped active (non-tombstoned) follow list. */
  listFollows: async (followerId: string, limit = 50): Promise<FollowView[]> => {
    const rows = await deps.listActiveFollowsByFollower(followerId, Math.min(Math.max(limit, 1), 200));
    return rows.map((r) => ({
      followeeRef: (r.followeeAudienceUserId ?? r.followeeCreatorProfileRef) as string,
      followeeKind: r.followeeKind,
      followedAt: r.createdAt.toISOString(),
    }));
  },
  /** Owner-scoped share facts. */
  listShares: async (audienceUserId: string, limit = 50): Promise<ContentRefView[]> => {
    const rows = await deps.listSharesByUser(audienceUserId, Math.min(Math.max(limit, 1), 200));
    return rows.map(toContentRefView);
  },
  /** PUBLIC visible-comments read on published content (anonymous OK). */
  listPublicComments: async (
    contentRef: string,
    limit = 100,
  ): Promise<PublicCommentView[] | null> => {
    const content = await deps.findPublishedContentById(contentRef);
    if (!content) return null; // unknown or unpublished — no existence leak
    const rows = await deps.listVisibleComments(contentRef, Math.min(Math.max(limit, 1), 200));
    const handles = await deps.findAudienceUsersByIds(rows.map((r) => r.authorId));
    return rows.map((r) => ({
      commentId: r.id,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      parentCommentId: r.parentCommentId,
      authorHandle: handles.get(r.authorId) ?? "member",
    }));
  },
});

/** Convenience: build the reader from a full SocialRepository. */
export const socialReaderFromRepository = (repo: SocialRepository) =>
  createSocialReader({
    findAudienceUserById: repo.findAudienceUserById,
    listLikesByUser: repo.listLikesByUser,
    listSavesByUser: repo.listSavesByUser,
    listActiveFollowsByFollower: repo.listActiveFollowsByFollower,
    listSharesByUser: repo.listSharesByUser,
    findAudienceUsersByIds: repo.findAudienceUsersByIds,
    listVisibleComments: repo.listVisibleComments,
    findPublishedContentById: repo.findPublishedContentById,
  });
