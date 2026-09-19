/**
 * Drizzle repository adapter for the audience PUBLIC CONTENT aggregate
 * (Stage 2.13). Implements the AudienceRepository port from types.ts,
 * mirroring the services/publishing-engine adapter conventions exactly:
 *
 *  - `Database` (postgres.js) typed pool shared from the composition root;
 *  - runInTransaction exposes the SAME transaction connection to the domain
 *    mutations and the injected auditWriter (D2.4-1 seam) so a projection
 *    and its audit record commit atomically — a rollback removes both;
 *  - the ONLY mutation path is setStatus (published → unpublished);
 *  - all access is parameterized.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  audienceUsers,
  createDatabase,
  publicContent,
  watchProgress,
  type Database,
  type PublicContentRow,
} from "@stratifit/database";
import type {
  AudienceAuditWriter,
  AudienceRepository,
  AudienceTransaction,
  NewPublicContentInput,
  PublicContentRecord,
  PublicContentStatus,
  WatchProgressRecord,
} from "./types";

/** Unique-violation signal for the slug/idempotency backstops (23505). */
export class UniqueViolationSignal extends Error {
  constructor(readonly constraint: string | null) {
    super(`unique violation: ${constraint ?? "unknown"}`);
  }
}

const toRecord = (row: PublicContentRow): PublicContentRecord => ({
  id: row.id,
  orgId: row.orgId,
  publicationId: row.publicationId,
  publicationVersionId: row.publicationVersionId,
  slug: row.slug,
  // Content type is validated by the DB CHECK; narrow through the union.
  contentType: row.contentType as PublicContentRecord["contentType"],
  title: row.title,
  synopsis: row.synopsis,
  mediaRefs: (row.mediaRefs ?? []) as PublicContentRecord["mediaRefs"],
  durationSeconds: row.durationSeconds,
  creatorProfileRef: row.creatorProfileRef,
  seriesRef: row.seriesRef,
  episodeNumber: row.episodeNumber,
  categories: (row.categories ?? []) as PublicContentRecord["categories"],
  publishedAt: row.publishedAt,
  status: row.status as PublicContentStatus,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const insertValues = (input: NewPublicContentInput) => ({
  orgId: input.orgId,
  publicationId: input.publicationId,
  publicationVersionId: input.publicationVersionId,
  slug: input.slug,
  contentType: input.contentType,
  title: input.title,
  synopsis: input.synopsis,
  mediaRefs: input.mediaRefs,
  publishedAt: input.publishedAt,
  categories: input.categories,
});

const isUniqueViolation = (e: unknown): e is { code: string; constraint_name?: string; detail?: string } => {
  // Drizzle wraps driver errors (DrizzleQueryError.cause = PostgresError),
  // so walk the cause chain for the 23505 unique-violation code.
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && typeof cur === "object" && cur !== null; depth++) {
    if ((cur as { code?: string }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
};

const classifyUnique = (e: { constraint_name?: string; detail?: string }): string | null =>
  e.constraint_name ??
  (e.detail?.includes("slug") ? "public_content_slug_unique" : "public_content_publication_version_unique");

export interface DrizzleAudienceRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /**
   * D2.4-1: the admin-audit transaction writer (structural type;
   * composition roots pass `createAdminAuditService(...).transactionWriter()`).
   * REQUIRED for any mutation composition (the Control root that wires the
   * consumers). READ-ONLY compositions (the Media public fragment) may omit
   * it — any attempted mutation then fails LOUDLY rather than silently
   * skipping audit (no fabricated/no-op audit paths).
   */
  auditWriter?: AudienceAuditWriter;
}

const mutationsFor = (exec: Database, deps: DrizzleAudienceRepositoryDeps) => {
  const insertContent = async (input: NewPublicContentInput): Promise<PublicContentRecord> => {
    try {
      const [row] = await exec.insert(publicContent).values(insertValues(input)).returning();
      return toRecord(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new UniqueViolationSignal(classifyUnique(e));
      throw e;
    }
  };
  return {
    findByPublicationVersionId: async (publicationVersionId: string): Promise<PublicContentRecord | null> => {
      const [row] = await exec.select().from(publicContent).where(eq(publicContent.publicationVersionId, publicationVersionId)).limit(1);
      return row ? toRecord(row) : null;
    },
    findByPublicationId: async (publicationId: string): Promise<PublicContentRecord | null> => {
      const [row] = await exec.select().from(publicContent).where(eq(publicContent.publicationId, publicationId)).limit(1);
      return row ? toRecord(row) : null;
    },
    findBySlug: async (slug: string): Promise<PublicContentRecord | null> => {
      const [row] = await exec.select().from(publicContent).where(eq(publicContent.slug, slug)).limit(1);
      return row ? toRecord(row) : null;
    },
    listPublished: async (): Promise<readonly PublicContentRecord[]> => {
      const rows = await exec
        .select()
        .from(publicContent)
        .where(eq(publicContent.status, "published"))
        .orderBy(desc(publicContent.publishedAt));
      return rows.map(toRecord);
    },
    insertContent,
    setStatus: async (publicationId: string, status: PublicContentStatus): Promise<PublicContentRecord | null> => {
      // The ONLY sanctioned mutation. Conditions on status='published' so a
      // repeated unpublish (or an unknown publication id) is a natural no-op.
      const [row] = await exec
        .update(publicContent)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(publicContent.publicationId, publicationId), eq(publicContent.status, "published")))
        .returning();
      return row ? toRecord(row) : null;
    },
    // -----------------------------------------------------------------
    // Stage 2.14 — watch progress (owner-scoped audience state).
    // -----------------------------------------------------------------
    findAudienceUserById: async (
      audienceUserId: string,
    ): Promise<{ id: string; orgId: string } | null> => {
      const [row] = await exec
        .select({ id: audienceUsers.id, orgId: audienceUsers.orgId })
        .from(audienceUsers)
        .where(and(eq(audienceUsers.id, audienceUserId), eq(audienceUsers.status, "active")))
        .limit(1);
      return row ?? null;
    },
    findPublishedContentById: async (
      contentRef: string,
    ): Promise<{ id: string; orgId: string } | null> => {
      const [row] = await exec
        .select({ id: publicContent.id, orgId: publicContent.orgId })
        .from(publicContent)
        .where(and(eq(publicContent.id, contentRef), eq(publicContent.status, "published")))
        .limit(1);
      return row ?? null;
    },
    upsertProgress: async (input: {
      orgId: string;
      audienceUserId: string;
      contentRef: string;
      positionSeconds: number;
    }): Promise<WatchProgressRecord> => {
      // Idempotent by UNIQUE(audience_user_id, content_ref) — a repeated
      // write UPDATES the same row (position + updatedAt) and never creates
      // a second one.
      const [row] = await exec
        .insert(watchProgress)
        .values({
          orgId: input.orgId,
          audienceUserId: input.audienceUserId,
          contentRef: input.contentRef,
          positionSeconds: input.positionSeconds,
        })
        .onConflictDoUpdate({
          target: [watchProgress.audienceUserId, watchProgress.contentRef],
          set: { positionSeconds: input.positionSeconds, updatedAt: new Date() },
        })
        .returning({
          audienceUserId: watchProgress.audienceUserId,
          contentRef: watchProgress.contentRef,
          positionSeconds: watchProgress.positionSeconds,
          updatedAt: watchProgress.updatedAt,
        });
      if (!row) throw new Error("watch progress upsert returned no row");
      return { ...row, updatedAt: row.updatedAt.toISOString() };
    },
    listProgressByUser: async (audienceUserId: string, limit: number): Promise<WatchProgressRecord[]> => {
      const rows = await exec
        .select({
          audienceUserId: watchProgress.audienceUserId,
          contentRef: watchProgress.contentRef,
          positionSeconds: watchProgress.positionSeconds,
          updatedAt: watchProgress.updatedAt,
        })
        .from(watchProgress)
        .where(eq(watchProgress.audienceUserId, audienceUserId))
        .orderBy(desc(watchProgress.updatedAt))
        .limit(limit);
      return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
    },
    appendAudit: (entry: Parameters<AudienceAuditWriter["appendWithin"]>[1]) => {
      if (!deps.auditWriter) {
        throw new Error("audience audit writer not configured; mutations are not available in read-only compositions");
      }
      return deps.auditWriter.appendWithin(exec, entry);
    },
  };
};

const transactionFor = (exec: Database, deps: DrizzleAudienceRepositoryDeps): AudienceTransaction => {
  const m = mutationsFor(exec, deps);
  return {
    findByPublicationVersionId: m.findByPublicationVersionId,
    findByPublicationId: m.findByPublicationId,
    findBySlug: m.findBySlug,
    insertContent: m.insertContent,
    setStatus: m.setStatus,
    appendAudit: m.appendAudit,
  };
};

export const createDrizzleAudienceRepository = (deps: DrizzleAudienceRepositoryDeps): AudienceRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db, deps);

  return {
    findByPublicationVersionId: direct.findByPublicationVersionId,
    findByPublicationId: direct.findByPublicationId,
    findBySlug: direct.findBySlug,
    listPublished: direct.listPublished,
    insertContent: (input) => direct.insertContent(input),
    setStatus: (publicationId, status) => direct.setStatus(publicationId, status),
    findAudienceUserById: (audienceUserId) => direct.findAudienceUserById(audienceUserId),
    findPublishedContentById: (contentRef) => direct.findPublishedContentById(contentRef),
    upsertProgress: (input) => direct.upsertProgress(input),
    listProgressByUser: (audienceUserId, limit) => direct.listProgressByUser(audienceUserId, limit),
    // D2.4-1: the SAME connection runs the mutation and the audit append.
    runInTransaction: async <T>(work: (tx: AudienceTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => work(transactionFor(trx as unknown as Database, deps))),
  };
};
