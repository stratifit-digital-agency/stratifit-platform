/**
 * Durable PublicationReader + local platform adapter (Stage 2.12).
 *
 * DurablePublicationReader implements the EXISTING PublicationReader
 * interface (publishing.ts) against the durable publication family, so the
 * Stratifit Media composition swap is backend-only — Media keeps reading
 * through the same abstraction and never imports the database package
 * (enforced by lint boundaries; the reader lives inside the public-safe
 * publishing-engine service, which MAY use @stratifit/database).
 *
 * PUBLIC-SAFE BOUNDARY (plan section 17): the reader exposes ONLY published
 * rows and public-safe fields. `contentRef` carries the OPAQUE publication
 * id — NEVER the internal subject_ref / production / organization identity —
 * and no worker, infrastructure, or credential data exists on the record.
 * Non-published (draft/pending/approved/scheduled/publishing/failed/
 * unpublished) publications are invisible to `get` and `listPublished`.
 */
import { and, asc, eq } from "drizzle-orm";
import { createDatabase, publicationVersions, publications, type Database } from "@stratifit/database";
import type { PublicationRecord } from "./publishing";
import type { PublicationDeliveryPayload, PublicationPlatformAdapter, PlatformTarget } from "./types";

export interface DurablePublicationReaderDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
}

/** Published rows only, mapped to the existing public-safe record shape. */
const publishedRecord = (
  pub: typeof publications.$inferSelect,
  version: typeof publicationVersions.$inferSelect | null | undefined,
): PublicationRecord => ({
  // OPAQUE: the publication id itself — never the internal subject_ref.
  contentRef: pub.id,
  publicationId: pub.id,
  title: version?.title ?? "",
  ...(version?.synopsis ? { synopsis: version.synopsis } : {}),
  contentType: pub.contentType as PublicationRecord["contentType"],
  target: pub.platformTarget,
  status: "published",
  // The moment the successful publish attempt was initiated.
  ...(pub.lastAttemptAt ? { publishedAt: pub.lastAttemptAt.toISOString() } : {}),
});

export class DurablePublicationReader {
  private readonly db: Database;

  constructor(deps: DurablePublicationReaderDeps) {
    this.db = deps.db ?? createDatabase(deps.databaseUrl as string);
  }

  /** Existing PublicationReader.listPublished — published rows only, oldest first. */
  async listPublished(target?: string): Promise<readonly PublicationRecord[]> {
    const rows = await this.db
      .select({ publication: publications, version: publicationVersions })
      .from(publications)
      .leftJoin(publicationVersions, eq(publicationVersions.id, publications.currentVersionId))
      .where(
        target === undefined
          ? eq(publications.status, "published")
          : and(eq(publications.status, "published"), eq(publications.platformTarget, target)),
      )
      .orderBy(asc(publications.lastAttemptAt));
    return rows.map((r) => publishedRecord(r.publication, r.version));
  }

  /** Existing PublicationReader.get — undefined unless the publication is published. */
  async get(publicationId: string): Promise<PublicationRecord | undefined> {
    const [row] = await this.db
      .select({ publication: publications, version: publicationVersions })
      .from(publications)
      .leftJoin(publicationVersions, eq(publicationVersions.id, publications.currentVersionId))
      .where(and(eq(publications.id, publicationId), eq(publications.status, "published")))
      .limit(1);
    return row ? publishedRecord(row.publication, row.version) : undefined;
  }

  /** Structural satisfaction of the existing interface. */
  asReader(): import("./publishing").PublicationReader {
    return {
      listPublished: (target?: string) => this.listPublished(target),
      get: (publicationId: string) => this.get(publicationId),
    };
  }
}

/**
 * Local platform adapter for the durable flow (D2.12-F): delivery to
 * Stratifit Media IS the durable publication itself, so the adapter simply
 * acknowledges acceptance with an opaque external id. No network, no
 * credentials, no worker. External platforms arrive later as additional
 * PublicationPlatformAdapter implementations.
 */
export class DurableStratifitMediaAdapter implements PublicationPlatformAdapter {
  readonly target: PlatformTarget = "stratifit-media";

  async publish(payload: PublicationDeliveryPayload): Promise<{ externalId: string }> {
    return { externalId: `${payload.publicationId}:${payload.versionId}` };
  }
}
