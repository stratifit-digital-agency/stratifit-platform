/**
 * Public-service fragment of the audience module (Stage 2.13): the read API
 * Stratifit Media composes. This is the ONLY surface Media touches.
 *
 * SECURITY: the whitelist below is the enforcement point — a raw
 * PublicContentRecord NEVER crosses this boundary. The view carries exactly:
 * slug, title, synopsis, contentType, publishedAt, durationSeconds,
 * categories, mediaRefs (metadata only), and the OPAQUE contentRef
 * (public_content.id — never an internal production/asset/generation/QC id,
 * never org identity, never publication internals).
 */
import type {
  PublicContentRecord,
  PublicContentView,
} from "./types";
import { PUBLIC_CONTENT_TYPES } from "./types";

const isContentType = (v: string): v is PublicContentView["contentType"] =>
  (PUBLIC_CONTENT_TYPES as readonly string[]).includes(v);

/** Whitelist projection. Unknown taxonomy values fail closed (filtered out). */
export const toPublicView = (record: PublicContentRecord): PublicContentView | null => {
  if (!isContentType(record.contentType)) return null;
  if (record.status !== "published") return null;
  return {
    contentRef: record.id,
    slug: record.slug,
    title: record.title,
    ...(record.synopsis !== null && record.synopsis !== undefined ? { synopsis: record.synopsis } : {}),
    contentType: record.contentType,
    publishedAt: record.publishedAt.toISOString(),
    ...(record.durationSeconds !== null && record.durationSeconds !== undefined
      ? { durationSeconds: record.durationSeconds }
      : {}),
    categories: record.categories,
    mediaRefs: record.mediaRefs,
  };
};

export interface PublicContentReaderDeps {
  listContent(): Promise<readonly PublicContentRecord[]>;
  getContentBySlug(slug: string): Promise<PublicContentRecord | null>;
}

export interface PublicContentReader {
  /** Published-only, newest-first. Unpublished rows never appear. */
  listContent(): Promise<readonly PublicContentView[]>;
  /** Published-only; undefined for unknown OR unpublished slugs (no existence leak). */
  getContentBySlug(slug: string): Promise<PublicContentView | undefined>;
}

export const createPublicContentReader = (deps: PublicContentReaderDeps): PublicContentReader => ({
  listContent: async () => {
    const rows = await deps.listContent();
    return rows.map(toPublicView).filter((v): v is PublicContentView => v !== null);
  },
  getContentBySlug: async (slug: string) => {
    const row = await deps.getContentBySlug(slug);
    if (!row) return undefined;
    return toPublicView(row) ?? undefined;
  },
});
