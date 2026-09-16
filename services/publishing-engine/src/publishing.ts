import { z } from "zod";

/**
 * Publishing domain — deliberately separate from production.
 *
 * Production → QC → Approval → Publication Record → Publishing Engine →
 * Platform Adapter. No platform-specific logic exists in the production
 * domain; adapters encapsulate targets (Stratifit Media now; YouTube/TikTok/
 * Instagram/Facebook later).
 */

export const PublicationRecord = z.object({
  publicationId: z.string().min(1),
  /** Reference into the production domain; publishing never imports it. */
  contentRef: z.string().min(1),
  title: z.string().min(1),
  /** Public-safe synopsis; publishing stores only publishable fields. */
  synopsis: z.string().optional(),
  contentType: z.enum(["film", "series", "episode", "short", "music", "documentary", "trailer"]),
  target: z.string().min(1),
  status: z.enum(["draft", "approved", "published", "failed"]),
  publishedAt: z.string().datetime().optional(),
});

export type PublicationRecord = z.infer<typeof PublicationRecord>;

export interface PlatformAdapter {
  readonly target: string;
  publish(record: PublicationRecord): Promise<{ externalId?: string }>;
}

/** Read API surface for public-facing apps (Stratifit Media consumes this). */
export interface PublicationReader {
  listPublished(target?: string): Promise<readonly PublicationRecord[]>;
  get(publicationId: string): Promise<PublicationRecord | undefined>;
}

export class InMemoryPublicationStore implements PublicationReader {
  private readonly records = new Map<string, PublicationRecord>();

  async save(record: PublicationRecord): Promise<void> {
    this.records.set(record.publicationId, record);
  }

  async listPublished(target?: string): Promise<readonly PublicationRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === "published" && (target === undefined || r.target === target))
      .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
  }

  async get(publicationId: string): Promise<PublicationRecord | undefined> {
    return this.records.get(publicationId);
  }
}

/**
 * Stratifit Media adapter — records success on the store without any network
 * or production-domain involvement. External social targets arrive later as
 * additional PlatformAdapter implementations.
 */
export class StratifitMediaAdapter implements PlatformAdapter {
  readonly target = "stratifit-media";

  constructor(private readonly store: InMemoryPublicationStore) {}

  async publish(record: PublicationRecord): Promise<{ externalId?: string }> {
    const published: PublicationRecord = {
      ...record,
      target: this.target,
      status: "published",
      publishedAt: new Date().toISOString(),
    };
    await this.store.save(published);
    return { externalId: published.publicationId };
  }
}

/** Publishing engine facade over a store + registered adapters. */
export class PublishingEngine {
  constructor(
    private readonly store: InMemoryPublicationStore,
    private readonly adapters: readonly PlatformAdapter[],
  ) {}

  adapterFor(target: string): PlatformAdapter | undefined {
    return this.adapters.find((a) => a.target === target);
  }

  /** A failed adapter must NOT invalidate the master asset or the record. */
  async publish(record: PublicationRecord, target: string): Promise<PublicationRecord> {
    const adapter = this.adapterFor(target);
    if (!adapter) throw new Error(`no adapter for target: ${target}`);
    try {
      await adapter.publish(record);
      return { ...record, status: "published" };
    } catch {
      await this.store.save({ ...record, status: "failed" });
      throw new Error(`publishing to ${target} failed; master asset unaffected`);
    }
  }
}
