import {
  createDrizzleSocialRepository,
  createSocialService,
  socialReaderFromRepository,
  type ContentRefView,
  type FollowView,
  type PublicCommentView,
  type SocialCommandResult,
  type SocialPrincipal,
  type SocialService,
} from "@stratifit/social";

/**
 * Social-graph access for the Media BFF (Stage 2.15).
 *
 * The repository is the SAME public-safe social module; Media never imports
 * the database or any internal service. The SocialPrincipal is ALWAYS the
 * server-derived audience identity resolved from the authenticated session
 * (lib/identity.ts): userId from the JIT-provisioned audience_users row and
 * emailVerified from the server-side mirror — no client field ever reaches
 * the service. Read-only composition for the reader; no audit writer exists
 * anywhere in this module (D2.14-2 pattern; social writes carry no audit).
 */
const repository = createDrizzleSocialRepository({
  databaseUrl: process.env.DATABASE_URL as string,
});

const reader = socialReaderFromRepository(repository);

/** ONE shared service instance over the shared repository. */
const service: SocialService = createSocialService({ repository });

/** Build the server-derived principal from the resolved media identity. */
export const principalOf = (identity: { userId: string; emailVerified: boolean }): SocialPrincipal => ({
  userId: identity.userId,
  emailVerified: identity.emailVerified,
});

/** Whitelisted BFF own-state like/save/share view (opaque contentRef only). */
export interface OwnContentRefView {
  readonly contentRef: string;
  readonly createdAt: string;
}

/** Whitelisted BFF follow view. */
export interface OwnFollowView {
  readonly followeeRef: string;
  readonly followeeKind: string;
  readonly followedAt: string;
}

/** Whitelisted BFF public-comment view (author handle, never a raw id). */
export interface PublicCommentBffView {
  readonly commentId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly parentCommentId: string | null;
  readonly authorHandle: string;
}

const toOwnView = (rows: readonly ContentRefView[]): OwnContentRefView[] =>
  rows.map((r) => ({ contentRef: r.contentRef, createdAt: r.createdAt }));

// ---------------------------------------------------------------------------
// Writes — the SocialCommandResult discriminators are mapped to API outcomes.
// ---------------------------------------------------------------------------

export type SocialWriteOutcome =
  | { ok: true; state: string }
  | { ok: false; reason: string; message: string };

const mapResult = async (
  result:
    | SocialCommandResult<{ kind: string }>
    | Promise<SocialCommandResult<{ kind: string }>>,
): Promise<SocialWriteOutcome> => {
  const r = await result;
  return r.ok
    ? { ok: true, state: r.value.kind }
    : { ok: false, reason: r.error.reason, message: r.error.message };
};

export const like = async (p: SocialPrincipal, contentRef: string) =>
  mapResult(service.like(p, { contentRef }));
export const unlike = async (p: SocialPrincipal, contentRef: string) =>
  mapResult(service.unlike(p, { contentRef }));
export const save = async (p: SocialPrincipal, contentRef: string) =>
  mapResult(service.save(p, { contentRef }));
export const unsave = async (p: SocialPrincipal, contentRef: string) =>
  mapResult(service.unsave(p, { contentRef }));

export const follow = async (p: SocialPrincipal, followeeRef: string) =>
  mapResult(service.follow(p, { followeeKind: "audience_user", followeeRef }));

export const unfollow = async (p: SocialPrincipal, followeeRef: string) =>
  mapResult(service.unfollow(p, { followeeKind: "audience_user", followeeRef }));

export const comment = async (
  p: SocialPrincipal,
  input: { contentRef: string; body: string; parentCommentId?: string | null },
) => {
  const result = await service.comment(p, input);
  return result.ok
    ? result.value.kind === "commented"
      ? ({ ok: true, state: result.value.kind, id: result.value.commentId } as const)
      : ({ ok: true, state: result.value.kind, id: result.value.shareId } as const)
    : ({ ok: false, reason: result.error.reason, message: result.error.message } as const);
};

export const share = async (
  p: SocialPrincipal,
  input: { contentRef: string; channel: "copy_link" | "external" },
) => {
  const result = await service.share(p, input);
  return result.ok
    ? result.value.kind === "shared"
      ? ({ ok: true, state: result.value.kind, id: result.value.shareId } as const)
      : ({ ok: true, state: result.value.kind, id: result.value.commentId } as const)
    : ({ ok: false, reason: result.error.reason, message: result.error.message } as const);
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listLikes = async (p: SocialPrincipal, limit?: number): Promise<OwnContentRefView[]> =>
  toOwnView(await reader.listLikes(p.userId, limit));

export const listSaves = async (p: SocialPrincipal, limit?: number): Promise<OwnContentRefView[]> =>
  toOwnView(await reader.listSaves(p.userId, limit));

export const listFollows = async (p: SocialPrincipal, limit?: number): Promise<OwnFollowView[]> =>
  (await reader.listFollows(p.userId, limit)).map((f: FollowView) => ({
    followeeRef: f.followeeRef,
    followeeKind: f.followeeKind,
    followedAt: f.followedAt,
  }));

export const listShares = async (p: SocialPrincipal, limit?: number): Promise<OwnContentRefView[]> =>
  toOwnView(await reader.listShares(p.userId, limit));

/** Public visible-comments read; null = unknown/unpublished content (404). */
export const listPublicComments = async (
  contentRef: string,
  limit?: number,
): Promise<PublicCommentBffView[] | null> => {
  const rows = await reader.listPublicComments(contentRef, limit);
  if (rows === null) return null;
  return rows.map(
    (r: PublicCommentView): PublicCommentBffView => ({
      commentId: r.commentId,
      body: r.body,
      createdAt: r.createdAt,
      parentCommentId: r.parentCommentId,
      authorHandle: r.authorHandle,
    }),
  );
};
