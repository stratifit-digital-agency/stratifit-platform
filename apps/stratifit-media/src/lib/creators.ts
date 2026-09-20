import {
  createDrizzlePeopleRepository,
  toPublicCreatorViews,
  type PublicCreatorView,
} from "@stratifit/people";

/**
 * Public creators read surface for the Media BFF (Stage 2.16, D2.16-8).
 *
 * Media reads ACTIVE creator profiles ONLY through the People module's
 * public-safe projection — the same read-only composition pattern as
 * lib/content.ts. The repository is constructed WITHOUT an audit writer, so
 * any mutation attempt fails loudly (public reads only; there is no public
 * creator signup/editing path).
 *
 * The projection whitelist (services/people/src/public.ts) exposes ONLY:
 * handle, displayName, bio, interests, avatarRef, posterRef, status.
 * No internal row ids, no org ids, no publication ids, no storage
 * paths/URLs — avatarRef/posterRef are opaque asset-version references.
 * Only status = 'active' rows are ever returned (paused/unpublished
 * profiles are invisible).
 */

const repository = createDrizzlePeopleRepository({
  databaseUrl: process.env.DATABASE_URL as string,
});

/** Public creator directory: active profiles, handle-ordered. */
export const listCreators = async (limit?: number): Promise<PublicCreatorView[]> =>
  toPublicCreatorViews(await repository.listActiveProfiles(limit ?? 50));

/** Public creator detail by handle; null = unknown/inactive (404, no leak). */
export const getCreatorByHandle = async (handle: string): Promise<PublicCreatorView | null> => {
  const row = await repository.findActiveProfileByHandle(handle);
  if (!row) return null;
  return toPublicCreatorViews([row])[0] ?? null;
};
