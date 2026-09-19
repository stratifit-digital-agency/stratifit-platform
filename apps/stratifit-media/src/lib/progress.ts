import { createDrizzleAudienceRepository } from "@stratifit/audience";

/**
 * Audience-private watch-progress access for the Media BFF (Stage 2.14).
 *
 * The repository is the SAME public-safe audience module used by
 * lib/content.ts — Media never imports the database or any internal
 * service. The audienceUserId is ALWAYS the server-derived audience
 * identity resolved from the authenticated session (lib/identity.ts);
 * no client-supplied user/org authority ever reaches this module.
 * Read-only composition: no audit writer is configured, and watch
 * progress writes no audit by design (D2.14-2).
 */
const repository = createDrizzleAudienceRepository({
  databaseUrl: process.env.DATABASE_URL as string,
});

/** Owner-scoped progress rows for the authenticated audience user. */
export const getProgress = (audienceUserId: string, limit = 50) =>
  repository.listProgressByUser(audienceUserId, limit);

/** Whitelisted BFF view — contentRef is the opaque public content id. */
export interface ProgressView {
  readonly contentRef: string;
  readonly positionSeconds: number;
  readonly updatedAt: string;
}

export const toProgressView = (row: {
  audienceUserId: string;
  contentRef: string;
  positionSeconds: number;
  updatedAt: string;
}): ProgressView => ({
  contentRef: row.contentRef,
  positionSeconds: row.positionSeconds,
  updatedAt: row.updatedAt,
});

/** Upsert one (user, content) progress row through the audience service port. */
export const upsertProgress = async (
  audienceUserId: string,
  input: { contentRef: string; positionSeconds: number },
) => {
  const user = await repository.findAudienceUserById(audienceUserId);
  if (!user) return { ok: false as const, reason: "user_not_found" as const };
  const content = await repository.findPublishedContentById(input.contentRef);
  if (!content) return { ok: false as const, reason: "content_not_found" as const };
  const record = await repository.upsertProgress({
    orgId: user.orgId,
    audienceUserId,
    contentRef: input.contentRef,
    positionSeconds: input.positionSeconds,
  });
  return { ok: true as const, record };
};
