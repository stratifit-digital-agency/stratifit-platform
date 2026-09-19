/**
 * Drizzle repository adapter for the SOCIAL GRAPH aggregates (Stage 2.15).
 * Implements the SocialRepository port from types.ts, mirroring the
 * services/audience adapter conventions:
 *
 *  - `Database` (postgres.js via Drizzle) typed pool shared from the
 *    composition root (or built from a URL);
 *  - all access parameterized; unique violations surfaced as signals;
 *  - likes/saves: hard toggles (insert/delete);
 *  - follow_graph: tombstone via deleted_at + reactivation;
 *  - comments: insert + visible-only public list (no hard delete);
 *  - shares: insert-only immutable facts.
 */
import { and, asc, eq, inArray, isNull, desc } from "drizzle-orm";
import {
  comments,
  createDatabase,
  followGraph,
  likes,
  publicContent,
  audienceUsers,
  saves,
  shares,
  type Database,
} from "@stratifit/database";
import type {
  CommentRecord,
  CommentVisibility,
  FolloweeKind,
  LikeRecord,
  SaveRecord,
  ShareChannel,
  ShareRecord,
  SocialRepository,
} from "./types";

/** Unique-violation signal for idempotency backstops (23505). */
export class UniqueViolationSignal extends Error {
  constructor(readonly constraint: string | null) {
    super(`unique violation: ${constraint ?? "unknown"}`);
  }
}

const isUniqueViolation = (e: unknown): boolean => {
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && typeof cur === "object" && cur !== null; depth++) {
    if ((cur as { code?: string }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
};

export interface DrizzleSocialRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
}

export const createDrizzleSocialRepository = (deps: DrizzleSocialRepositoryDeps): SocialRepository => {
  const exec: Database = deps.db ?? createDatabase(deps.databaseUrl as string);

  return {
    findPublishedContentById: async (contentRef) => {
      const [row] = await exec
        .select({ id: publicContent.id, orgId: publicContent.orgId })
        .from(publicContent)
        .where(and(eq(publicContent.id, contentRef), eq(publicContent.status, "published")))
        .limit(1);
      return row ?? null;
    },

    findAudienceUserById: async (audienceUserId) => {
      const [row] = await exec
        .select({ id: audienceUsers.id, orgId: audienceUsers.orgId, handle: audienceUsers.handle })
        .from(audienceUsers)
        .where(and(eq(audienceUsers.id, audienceUserId), eq(audienceUsers.status, "active")))
        .limit(1);
      return row ? { id: row.id, orgId: row.orgId, handle: row.handle ?? null } : null;
    },

    findAudienceUsersByIds: async (ids) => {
      if (ids.length === 0) return new Map();
      const rows = await exec
        .select({ id: audienceUsers.id, handle: audienceUsers.handle })
        .from(audienceUsers)
        .where(inArray(audienceUsers.id, [...ids]));
      return new Map(rows.map((r) => [r.id, r.handle]));
    },

    // -----------------------------------------------------------------
    // likes — hard-delete toggle
    // -----------------------------------------------------------------
    findLike: async (audienceUserId, contentRef) => {
      const [row] = await exec
        .select({ audienceUserId: likes.audienceUserId, contentRef: likes.contentRef, createdAt: likes.createdAt })
        .from(likes)
        .where(and(eq(likes.audienceUserId, audienceUserId), eq(likes.contentRef, contentRef)))
        .limit(1);
      return row ?? null;
    },
    insertLike: async (input) => {
      try {
        const [row] = await exec.insert(likes).values(input).returning({
          audienceUserId: likes.audienceUserId,
          contentRef: likes.contentRef,
          createdAt: likes.createdAt,
        });
        return row!;
      } catch (e) {
        if (isUniqueViolation(e)) throw new UniqueViolationSignal("likes_user_content_unique");
        throw e;
      }
    },
    deleteLike: async (audienceUserId, contentRef) => {
      const rows = await exec
        .delete(likes)
        .where(and(eq(likes.audienceUserId, audienceUserId), eq(likes.contentRef, contentRef)))
        .returning({ audienceUserId: likes.audienceUserId });
      return rows.length > 0;
    },
    listLikesByUser: async (audienceUserId, limit) =>
      exec
        .select({ audienceUserId: likes.audienceUserId, contentRef: likes.contentRef, createdAt: likes.createdAt })
        .from(likes)
        .where(eq(likes.audienceUserId, audienceUserId))
        .orderBy(desc(likes.createdAt))
        .limit(limit),

    // -----------------------------------------------------------------
    // saves — hard-delete toggle
    // -----------------------------------------------------------------
    findSave: async (audienceUserId, contentRef) => {
      const [row] = await exec
        .select({ audienceUserId: saves.audienceUserId, contentRef: saves.contentRef, createdAt: saves.createdAt })
        .from(saves)
        .where(and(eq(saves.audienceUserId, audienceUserId), eq(saves.contentRef, contentRef)))
        .limit(1);
      return row ?? null;
    },
    insertSave: async (input) => {
      try {
        const [row] = await exec.insert(saves).values(input).returning({
          audienceUserId: saves.audienceUserId,
          contentRef: saves.contentRef,
          createdAt: saves.createdAt,
        });
        return row!;
      } catch (e) {
        if (isUniqueViolation(e)) throw new UniqueViolationSignal("saves_user_content_unique");
        throw e;
      }
    },
    deleteSave: async (audienceUserId, contentRef) => {
      const rows = await exec
        .delete(saves)
        .where(and(eq(saves.audienceUserId, audienceUserId), eq(saves.contentRef, contentRef)))
        .returning({ audienceUserId: saves.audienceUserId });
      return rows.length > 0;
    },
    listSavesByUser: async (audienceUserId, limit) =>
      exec
        .select({ audienceUserId: saves.audienceUserId, contentRef: saves.contentRef, createdAt: saves.createdAt })
        .from(saves)
        .where(eq(saves.audienceUserId, audienceUserId))
        .orderBy(desc(saves.createdAt))
        .limit(limit),

    // -----------------------------------------------------------------
    // follow_graph — tombstone lifecycle
    // -----------------------------------------------------------------
    findFollowAnyState: async (followerId, followeeKind, followeeRef) => {
      const where =
        followeeKind === "audience_user"
          ? and(
              eq(followGraph.followerId, followerId),
              eq(followGraph.followeeKind, followeeKind),
              eq(followGraph.followeeAudienceUserId, followeeRef),
            )
          : and(
              eq(followGraph.followerId, followerId),
              eq(followGraph.followeeKind, followeeKind),
              eq(followGraph.followeeCreatorProfileRef, followeeRef),
            );
      const [row] = await exec
        .select({
          id: followGraph.id,
          followerId: followGraph.followerId,
          followeeKind: followGraph.followeeKind,
          followeeAudienceUserId: followGraph.followeeAudienceUserId,
          followeeCreatorProfileRef: followGraph.followeeCreatorProfileRef,
          deletedAt: followGraph.deletedAt,
          createdAt: followGraph.createdAt,
          updatedAt: followGraph.updatedAt,
        })
        .from(followGraph)
        .where(where)
        .limit(1);
      return row
        ? { ...row, followeeKind: row.followeeKind as FolloweeKind }
        : null;
    },
    insertFollow: async (input) => {
      const [row] = await exec
        .insert(followGraph)
        .values({
          orgId: input.orgId,
          followerId: input.followerId,
          followeeKind: input.followeeKind,
          followeeAudienceUserId: input.followeeAudienceUserId,
          followeeCreatorProfileRef: input.followeeCreatorProfileRef,
        })
        .returning({
          id: followGraph.id,
          followerId: followGraph.followerId,
          followeeKind: followGraph.followeeKind,
          followeeAudienceUserId: followGraph.followeeAudienceUserId,
          followeeCreatorProfileRef: followGraph.followeeCreatorProfileRef,
          deletedAt: followGraph.deletedAt,
          createdAt: followGraph.createdAt,
          updatedAt: followGraph.updatedAt,
        });
      return { ...row!, followeeKind: row!.followeeKind as FolloweeKind };
    },
    reactivateFollow: async (followId) => {
      const [row] = await exec
        .update(followGraph)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(followGraph.id, followId))
        .returning({
          id: followGraph.id,
          followerId: followGraph.followerId,
          followeeKind: followGraph.followeeKind,
          followeeAudienceUserId: followGraph.followeeAudienceUserId,
          followeeCreatorProfileRef: followGraph.followeeCreatorProfileRef,
          deletedAt: followGraph.deletedAt,
          createdAt: followGraph.createdAt,
          updatedAt: followGraph.updatedAt,
        });
      return { ...row!, followeeKind: row!.followeeKind as FolloweeKind };
    },
    setFollowDeleted: async (followId, deletedAt) => {
      const [row] = await exec
        .update(followGraph)
        .set({ deletedAt, updatedAt: new Date() })
        .where(eq(followGraph.id, followId))
        .returning({
          id: followGraph.id,
          followerId: followGraph.followerId,
          followeeKind: followGraph.followeeKind,
          followeeAudienceUserId: followGraph.followeeAudienceUserId,
          followeeCreatorProfileRef: followGraph.followeeCreatorProfileRef,
          deletedAt: followGraph.deletedAt,
          createdAt: followGraph.createdAt,
          updatedAt: followGraph.updatedAt,
        });
      return { ...row!, followeeKind: row!.followeeKind as FolloweeKind };
    },
    listActiveFollowsByFollower: async (followerId, limit) => {
      const rows = await exec
        .select({
          id: followGraph.id,
          followerId: followGraph.followerId,
          followeeKind: followGraph.followeeKind,
          followeeAudienceUserId: followGraph.followeeAudienceUserId,
          followeeCreatorProfileRef: followGraph.followeeCreatorProfileRef,
          deletedAt: followGraph.deletedAt,
          createdAt: followGraph.createdAt,
          updatedAt: followGraph.updatedAt,
        })
        .from(followGraph)
        .where(and(eq(followGraph.followerId, followerId), isNull(followGraph.deletedAt)))
        .orderBy(desc(followGraph.createdAt))
        .limit(limit);
      return rows.map((r) => ({ ...r, followeeKind: r.followeeKind as FolloweeKind }));
    },

    // -----------------------------------------------------------------
    // comments
    // -----------------------------------------------------------------
    insertComment: async (input) => {
      const [row] = await exec
        .insert(comments)
        .values({
          orgId: input.orgId,
          authorId: input.authorId,
          contentRef: input.contentRef,
          parentCommentId: input.parentCommentId,
          body: input.body,
          visibility: "visible" satisfies CommentVisibility,
        })
        .returning();
      return row as CommentRecord;
    },
    findVisibleCommentById: async (commentId) => {
      const [row] = await exec
        .select()
        .from(comments)
        .where(and(eq(comments.id, commentId), eq(comments.visibility, "visible")))
        .limit(1);
      return (row as CommentRecord | undefined) ?? null;
    },
    listVisibleComments: async (contentRef, limit) => {
      const rows = await exec
        .select()
        .from(comments)
        .where(and(eq(comments.contentRef, contentRef), eq(comments.visibility, "visible")))
        .orderBy(asc(comments.createdAt))
        .limit(limit);
      return rows as CommentRecord[];
    },

    // -----------------------------------------------------------------
    // shares — immutable facts (insert-only)
    // -----------------------------------------------------------------
    insertShare: async (input) => {
      const [row] = await exec.insert(shares).values(input).returning({
        audienceUserId: shares.audienceUserId,
        contentRef: shares.contentRef,
        channel: shares.channel,
        createdAt: shares.createdAt,
      });
      return { ...row!, channel: row!.channel as ShareChannel };
    },
    listSharesByUser: async (audienceUserId, limit) =>
      exec
        .select({
          audienceUserId: shares.audienceUserId,
          contentRef: shares.contentRef,
          channel: shares.channel,
          createdAt: shares.createdAt,
        })
        .from(shares)
        .where(eq(shares.audienceUserId, audienceUserId))
        .orderBy(desc(shares.createdAt))
        .limit(limit)
        .then((rows) =>
          rows.map((r) => ({ ...r, channel: r.channel as ShareChannel })),
        ),
  };
};
