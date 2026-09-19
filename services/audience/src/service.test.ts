/**
 * Unit tests for the audience PUBLIC CONTENT service (Stage 2.13).
 *
 * Covers the approved matrix: projection, duplicate no-op, slug generation
 * (unicode/diacritics/empty/length), slug collision probe, content-type
 * mapping, unpublish, repeated unpublish, missing projection, malformed
 * events, published-only reads, slug lookup, and the public projection
 * whitelist. The fake repository mirrors the real adapter semantics
 * (including unique-constraint backstops) without a database.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeEnvelope, type DomainEventEnvelope } from "@stratifit/contracts";
import { createAudienceService, slugify } from "./service";
import type {
  AudienceRepository,
  AudienceTransaction,
  NewPublicContentInput,
  PublicContentRecord,
} from "./types";
import { UniqueViolationSignal } from "./repository";
import { createPublicContentReader } from "./public";

// ---------------------------------------------------------------------------
// Fake repository (mirrors real adapter: uniques fire, setStatus conditions
// on published-only)
// ---------------------------------------------------------------------------

class FakeStore {
  rows: PublicContentRecord[] = [];
  private seq = 0;

  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  toRecord(input: NewPublicContentInput): PublicContentRecord {
    const now = new Date();
    return {
      id: this.nextId(),
      orgId: input.orgId,
      publicationId: input.publicationId,
      publicationVersionId: input.publicationVersionId,
      slug: input.slug,
      contentType: input.contentType,
      title: input.title,
      synopsis: input.synopsis,
      mediaRefs: [...input.mediaRefs],
      durationSeconds: null,
      creatorProfileRef: null,
      seriesRef: null,
      episodeNumber: null,
      categories: [...input.categories],
      publishedAt: input.publishedAt,
      status: "published",
      createdAt: now,
      updatedAt: now,
    };
  }
}

const makeRepo = (store: FakeStore, audit: { entries: Array<{ action: string; subjectId: string }> }) => {
  const record = (r: PublicContentRecord) => ({ ...r });
  const mutations = {
    findByPublicationVersionId: async (id: string) => {
      const row = store.rows.find((r) => r.publicationVersionId === id);
      return row ? record(row) : null;
    },
    findByPublicationId: async (id: string) => {
      const row = store.rows.find((r) => r.publicationId === id);
      return row ? record(row) : null;
    },
    findBySlug: async (slug: string) => {
      const row = store.rows.find((r) => r.slug === slug);
      return row ? record(row) : null;
    },
    listPublished: async () => store.rows.filter((r) => r.status === "published").map(record),
    insertContent: async (input: NewPublicContentInput) => {
      if (store.rows.some((r) => r.publicationVersionId === input.publicationVersionId)) {
        throw new UniqueViolationSignal("public_content_publication_version_unique");
      }
      if (store.rows.some((r) => r.slug === input.slug)) {
        throw new UniqueViolationSignal("public_content_slug_unique");
      }
      const row = store.toRecord(input);
      store.rows.push(row);
      return record(row);
    },
    setStatus: async (publicationId: string, status: "published" | "unpublished") => {
      const row = store.rows.find((r) => r.publicationId === publicationId && r.status === "published");
      if (!row) return null;
      const updated = { ...row, status, updatedAt: new Date() };
      store.rows = store.rows.map((r) => (r.id === row.id ? updated : r));
      return updated;
    },
    appendAudit: async (entry: { action: string; subjectId: string }) => {
      audit.entries.push({ action: entry.action, subjectId: entry.subjectId });
    },
  };
  const tx: AudienceTransaction = mutations;
  const repo: AudienceRepository = {
    ...mutations,
    runInTransaction: async <T,>(work: (t: AudienceTransaction) => Promise<T>) => work(tx),
  };
  return repo;
};

// ---------------------------------------------------------------------------
// Envelope factories (payload shape verified BUILD STEP 0)
// ---------------------------------------------------------------------------

const ORG = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const VER = "33333333-3333-4333-8333-333333333333";

const publishedEvent = (overrides?: { versionId?: string; title?: string; contentType?: string; publicationId?: string }): DomainEventEnvelope =>
  makeEnvelope({
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    name: "publication.published",
    correlation: { organizationId: ORG, publicationId: overrides?.publicationId ?? PUB },
    payload: {
      publicationId: overrides?.publicationId ?? PUB,
      versionId: overrides?.versionId ?? VER,
      versionNumber: 1,
      platformTarget: "stratifit-media",
      externalRef: "ext-1",
      title: overrides?.title ?? "Night Harbor",
      synopsis: "A test synopsis",
      contentType: overrides?.contentType ?? "film",
    },
  });

const unpublishedEvent = (publicationId: string = PUB): DomainEventEnvelope =>
  makeEnvelope({
    eventId: `evt-un-${Math.random().toString(36).slice(2, 10)}`,
    name: "publication.unpublished",
    correlation: { organizationId: ORG, publicationId },
    payload: { publicationId },
  });

// ---------------------------------------------------------------------------

let store: FakeStore;
let audit: { entries: Array<{ action: string; subjectId: string }> };
let service: ReturnType<typeof createAudienceService>;

beforeEach(() => {
  store = new FakeStore();
  audit = { entries: [] };
  service = createAudienceService({ repository: makeRepo(store, audit), slugify });
});

describe("slugify (D2.13-2 algorithm)", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Night Harbor")).toBe("night-harbor");
  });
  it("strips unicode diacritics (NFKD)", () => {
    expect(slugify("Café Näme")).toBe("cafe-name");
  });
  it("collapses punctuation runs", () => {
    expect(slugify("The  Quick ---  Brown!!Strike")).toBe("the-quick-brown-strike");
  });
  it("caps at 64 chars", () => {
    expect(slugify("x".repeat(100)).length).toBe(64);
  });
  it("falls back to content for empty/emoji-only titles", () => {
    expect(slugify("")).toBe("content");
    expect(slugify("🎉🎉")).toBe("content");
  });
});

describe("content-type mapping (D2.13-3)", () => {
  it("maps shared publication values 1:1", async () => {
    for (const ct of ["film", "short", "music", "documentary", "trailer", "series", "episode"] as const) {
      const s = createAudienceService({ repository: makeRepo(store, audit), slugify });
      const result = await s.projectPublished({
        envelope: publishedEvent({ contentType: ct, versionId: VER, title: `T ${ct}` }),
      });
      expect(result.ok).toBe(true);
      const row = store.rows[0]!;
      expect(row.contentType).toBe(ct);
      store.rows = [];
    }
  });
  it("fails closed on unmappable content types", async () => {
    const result = await service.projectPublished({ envelope: publishedEvent({ contentType: "hologram" }) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("invalid_event");
    expect(store.rows).toHaveLength(0);
  });
});

describe("projectPublished", () => {
  it("creates exactly one public_content row with a slug", async () => {
    const result = await service.projectPublished({ envelope: publishedEvent() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("projected");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.slug).toBe("night-harbor");
    expect(store.rows[0]!.status).toBe("published");
    // Same-tx audit: exactly one projection audit row.
    expect(audit.entries.map((a) => a.action)).toEqual(["audience.public_content_projected"]);
  });

  it("duplicate event is a NO-OP (no new row, no audit)", async () => {
    await service.projectPublished({ envelope: publishedEvent() });
    const before = store.rows.length;
    const auditBefore = audit.entries.length;
    const again = await service.projectPublished({ envelope: publishedEvent() });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.kind).toBe("noop_duplicate");
    expect(store.rows).toHaveLength(before);
    expect(audit.entries).toHaveLength(auditBefore);
  });

  it("rejects malformed payloads with invalid_event (fail closed)", async () => {
    const bad = makeEnvelope({
      eventId: "evt-bad",
      name: "publication.published",
      correlation: { organizationId: ORG },
      payload: { publicationId: "not-a-uuid" },
    });
    const result = await service.projectPublished({ envelope: bad });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("invalid_event");
  });

  it("rejects wrong event names", async () => {
    const wrong = makeEnvelope({ eventId: "e", name: "publication.failed", payload: {} });
    const result = await service.projectPublished({ envelope: wrong });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("invalid_event");
  });

  it("requires correlation.organizationId (org never comes from payload)", async () => {
    const noOrg = makeEnvelope({
      eventId: "e2",
      name: "publication.published",
      correlation: {},
      payload: { publicationId: PUB, versionId: VER, title: "T", contentType: "film" },
    });
    const result = await service.projectPublished({ envelope: noOrg });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("invalid_event");
  });

  it("slug collision resolves through the bounded probe (…-2)", async () => {
    // Pre-existing row with the same title/slug but a DIFFERENT version id.
    await service.projectPublished({
      envelope: publishedEvent({ versionId: "44444444-4444-4444-8444-444444444444", title: "Night Harbor" }),
    });
    const second = await service.projectPublished({
      envelope: publishedEvent({ versionId: "55555555-5555-4555-8555-555555555555", title: "Night Harbor" }),
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.kind).toBe("projected");
    const slugs = store.rows.map((r) => r.slug).sort();
    expect(slugs).toEqual(["night-harbor", "night-harbor-2"]);
  });

  it("exhausted probe falls back to the 6-hex hash suffix", async () => {
    const ids = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ];
    for (const versionId of ids) {
      const r = await service.projectPublished({ envelope: publishedEvent({ versionId, title: "Same" }) });
      expect(r.ok).toBe(true);
    }
    const slugs = store.rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(10);
    expect(slugs.filter((s) => s === "same").length + slugs.filter((s) => /^same-\d+$/.test(s)).length).toBe(9);
    expect(slugs.some((s) => /^same-[0-9a-f]{6}$/.test(s))).toBe(true);
  });
});

describe("unpublishContent (D2.13-1 consumer)", () => {
  it("flips published → unpublished and audits once", async () => {
    await service.projectPublished({ envelope: publishedEvent() });
    const result = await service.unpublishContent({ envelope: unpublishedEvent() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("unpublished");
    expect(store.rows[0]!.status).toBe("unpublished");
    expect(audit.entries.map((a) => a.action)).toEqual([
      "audience.public_content_projected",
      "audience.public_content_unpublished",
    ]);
  });

  it("repeated unpublish is a NO-OP (no second audit)", async () => {
    await service.projectPublished({ envelope: publishedEvent() });
    await service.unpublishContent({ envelope: unpublishedEvent() });
    const before = audit.entries.length;
    const again = await service.unpublishContent({ envelope: unpublishedEvent() });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.kind).toBe("noop_already_unpublished");
    expect(audit.entries).toHaveLength(before);
  });

  it("missing projection is a NO-OP (never invents rows)", async () => {
    const result = await service.unpublishContent({ envelope: unpublishedEvent() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("noop_missing");
    expect(store.rows).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });
});

describe("public reads", () => {
  it("listContent returns published-only, newest first", async () => {
    await service.projectPublished({ envelope: publishedEvent({ versionId: VER, title: "Old One" }) });
    await service.projectPublished({
      envelope: publishedEvent({ versionId: "44444444-4444-4444-8444-444444444444", title: "New One" }),
    });
    await service.unpublishContent({ envelope: unpublishedEvent(PUB) });
    const rows = await service.listContent();
    expect(rows.map((r) => r.title)).toEqual(["New One"]);
  });

  it("getContentBySlug finds published rows; unpublished/unknown disappear", async () => {
    await service.projectPublished({ envelope: publishedEvent() });
    expect((await service.getContentBySlug("night-harbor"))?.title).toBe("Night Harbor");
    await service.unpublishContent({ envelope: unpublishedEvent() });
    expect(await service.getContentBySlug("night-harbor")).toBeNull();
    expect(await service.getContentBySlug("nope")).toBeNull();
  });
});

describe("public projection whitelist", () => {
  it("exposes ONLY the approved safe fields", async () => {
    await service.projectPublished({ envelope: publishedEvent() });
    const reader = createPublicContentReader({
      listContent: () => service.listContent(),
      getContentBySlug: (slug) => service.getContentBySlug(slug),
    });
    const views = await reader.listContent();
    expect(views).toHaveLength(1);
    const json = JSON.stringify(views[0]);
    const view = views[0] as unknown as Record<string, unknown>;
    // Whitelist: every present key must be an approved safe field (optional
    // fields like durationSeconds/synopsis may be absent when null).
    const SAFE_KEYS = ["categories", "contentRef", "contentType", "durationSeconds", "mediaRefs", "publishedAt", "slug", "synopsis", "title"];
    for (const key of Object.keys(view)) expect(SAFE_KEYS).toContain(key);
    for (const required of ["contentRef", "slug", "title", "contentType", "publishedAt"]) {
      expect(Object.keys(view)).toContain(required);
    }
    // Forbidden identifiers must never appear in the projection.
    for (const forbidden of ["orgId", "publicationId", "publicationVersionId", "creatorProfileRef", "seriesRef"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("by-slug lookup returns undefined (not the raw record) for unpublished", async () => {
    await service.projectPublished({ envelope: publishedEvent() });
    const reader = createPublicContentReader({
      listContent: () => service.listContent(),
      getContentBySlug: (slug) => service.getContentBySlug(slug),
    });
    await service.unpublishContent({ envelope: unpublishedEvent() });
    expect(await reader.getContentBySlug("night-harbor")).toBeUndefined();
  });
});
