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
  MarkNotificationsReadInput,
  NewNotificationInput,
  NewPublicContentInput,
  NotificationRecord,
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
  progress: Array<{ audienceUserId: string; contentRef: string; positionSeconds: number; updatedAt: string }> = [];
  users: Array<{ id: string; orgId: string; status: string }> = [];
  notifications: NotificationRecord[] = [];
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
    insertNotificationIfAbsent: async (input: NewNotificationInput) => {
      if (store.notifications.some((n) => n.eventId === input.eventId)) return null;
      const row: NotificationRecord = {
        id: store.nextId(),
        orgId: input.orgId,
        audienceUserId: input.audienceUserId,
        kind: input.kind,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        eventId: input.eventId,
        title: input.title,
        body: input.body,
        readAt: null,
        createdAt: new Date(),
      };
      store.notifications.push(row);
      return { ...row };
    },
  };
  const tx: AudienceTransaction = mutations;
  const repo: AudienceRepository = {
    ...mutations,
    runInTransaction: async <T,>(work: (t: AudienceTransaction) => Promise<T>) => work(tx),
    // Stage 2.14 fake: in-memory (user, content) keyed progress family.
    findAudienceUserById: async (audienceUserId: string) =>
      store.users.find((u) => u.id === audienceUserId && u.status === "active") ?? null,
    findPublishedContentById: async (contentRef: string) =>
      store.rows.find((r) => r.id === contentRef && r.status === "published") ?? null,
    upsertProgress: async (input: {
      orgId: string;
      audienceUserId: string;
      contentRef: string;
      positionSeconds: number;
    }) => {
      const now = new Date().toISOString();
      const existing = store.progress.find(
        (pr) => pr.audienceUserId === input.audienceUserId && pr.contentRef === input.contentRef,
      );
      if (existing) {
        existing.positionSeconds = input.positionSeconds;
        existing.updatedAt = now;
        return { ...existing };
      }
      const created = {
        audienceUserId: input.audienceUserId,
        contentRef: input.contentRef,
        positionSeconds: input.positionSeconds,
        updatedAt: now,
      };
      store.progress.push(created);
      return { ...created };
    },
    listProgressByUser: async (audienceUserId: string, limit: number) =>
      store.progress
        .filter((pr) => pr.audienceUserId === audienceUserId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map((pr) => ({ ...pr })),
    // Stage 2.18 fake: owner-scoped notification reads/mutations mirroring
    // the real adapter semantics (insert lives on the shared mutations so
    // the transaction fake exposes it too).
    listNotificationsByUser: async (audienceUserId: string, limit: number) =>
      store.notifications
        .filter((n) => n.audienceUserId === audienceUserId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((n) => ({ ...n })),
    countUnreadByUser: async (audienceUserId: string) =>
      store.notifications.filter((n) => n.audienceUserId === audienceUserId && n.readAt === null).length,
    markNotificationsRead: async (audienceUserId: string, input: MarkNotificationsReadInput) => {
      const now = new Date();
      const wanted = "all" in input ? null : new Set<string>(input.ids);
      let count = 0;
      for (const n of store.notifications) {
        if (n.audienceUserId !== audienceUserId || n.readAt !== null) continue;
        if (wanted !== null && !wanted.has(n.id)) continue;
        (n as { readAt: Date | null }).readAt = now;
        count += 1;
      }
      return count;
    },
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


describe("watch progress (Stage 2.14, owner-scoped audience state)", () => {
  const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
  const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";

  const seedUser = (id: string) => store.users.push({ id, orgId: ORG, status: "active" });
  const seedPublished = (id: string) =>
    store.rows.push({
      id,
      orgId: ORG,
      publicationId: PUB,
      publicationVersionId: id,
      slug: `slug-${id.slice(0, 8)}`,
      contentType: "film",
      title: "T",
      synopsis: null,
      mediaRefs: [],
      publishedAt: new Date(),
      status: "published",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as PublicContentRecord);

  beforeEach(() => {
    seedUser(USER_A);
    seedUser(USER_B);
    seedPublished("44444444-4444-4444-8444-444444444444");
    seedPublished("55555555-5555-4555-8555-555555555555");
  });

  it("first write creates one row; second write updates the SAME row; repeat stays one row", async () => {
    const contentRef = "44444444-4444-4444-8444-444444444444";
    const r1 = await service.upsertProgress({ userId: USER_A }, { contentRef, positionSeconds: 30 });
    expect(r1.ok).toBe(true);
    const r2 = await service.upsertProgress({ userId: USER_A }, { contentRef, positionSeconds: 90 });
    expect(r2.ok).toBe(true);
    const r3 = await service.upsertProgress({ userId: USER_A }, { contentRef, positionSeconds: 90 });
    expect(r3.ok).toBe(true);
    const rows = await service.getProgress({ userId: USER_A });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.positionSeconds).toBe(90);
    expect(rows[0]!.contentRef).toBe(contentRef);
    expect(store.progress).toHaveLength(1);
  });

  it("owner-scoped: user A never reads user B rows; A cannot mutate B rows", async () => {
    const contentRef = "44444444-4444-4444-8444-444444444444";
    await service.upsertProgress({ userId: USER_A }, { contentRef, positionSeconds: 10 });
    expect(await service.getProgress({ userId: USER_B })).toHaveLength(0);
    expect(await service.getProgress({ userId: USER_A })).toHaveLength(1);
    // B's upsert for the same content creates B's OWN row, never touches A's.
    await service.upsertProgress({ userId: USER_B }, { contentRef, positionSeconds: 20 });
    const aRows = await service.getProgress({ userId: USER_A });
    expect(aRows[0]!.positionSeconds).toBe(10);
  });

  it("negative or non-integer position rejected with invalid_position", async () => {
    const contentRef = "44444444-4444-4444-8444-444444444444";
    const neg = await service.upsertProgress({ userId: USER_A }, { contentRef, positionSeconds: -1 });
    expect(neg).toMatchObject({ ok: false, error: { reason: "invalid_position" } });
    const frac = await service.upsertProgress({ userId: USER_A }, { contentRef, positionSeconds: 1.5 });
    expect(frac).toMatchObject({ ok: false, error: { reason: "invalid_position" } });
    expect(store.progress).toHaveLength(0);
  });

  it("unknown or malformed contentRef rejected with content_not_found", async () => {
    const missing = await service.upsertProgress(
      { userId: USER_A },
      { contentRef: "99999999-9999-4999-8999-999999999999", positionSeconds: 5 },
    );
    expect(missing).toMatchObject({ ok: false, error: { reason: "content_not_found" } });
    const malformed = await service.upsertProgress({ userId: USER_A }, { contentRef: "not-a-uuid", positionSeconds: 5 });
    expect(malformed).toMatchObject({ ok: false, error: { reason: "content_not_found" } });
  });

  it("unpublished content is rejected (published-only eligibility)", async () => {
    const contentRef = "55555555-5555-4555-8555-555555555555";
    const row = store.rows.find((r) => r.id === contentRef)!;
    (row as { status: string }).status = "unpublished";
    const res = await service.upsertProgress({ userId: USER_A }, { contentRef, positionSeconds: 5 });
    expect(res).toMatchObject({ ok: false, error: { reason: "content_not_found" } });
  });

  it("inactive/unknown audience user rejected with user_not_found (server-derived identity required)", async () => {
    const res = await service.upsertProgress(
      { userId: "cccccccc-3333-4333-8333-333333333333" },
      { contentRef: "44444444-4444-4444-8444-444444444444", positionSeconds: 5 },
    );
    expect(res).toMatchObject({ ok: false, error: { reason: "user_not_found" } });
    (store.users.find((u) => u.id === USER_A)! as { status: string }).status = "suspended";
    const suspended = await service.upsertProgress(
      { userId: USER_A },
      { contentRef: "44444444-4444-4444-8444-444444444444", positionSeconds: 5 },
    );
    expect(suspended).toMatchObject({ ok: false, error: { reason: "user_not_found" } });
  });

  it("getProgress limit clamps to [1, 200] and orders newest-first", async () => {
    const contentRefs = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
    for (const [i, contentRef] of contentRefs.entries()) {
      await service.upsertProgress({ userId: USER_A }, { contentRef, positionSeconds: i + 1 });
    }
    const rows = await service.getProgress({ userId: USER_A });
    expect(rows).toHaveLength(2);
    expect(new Date(rows[0]!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(rows[1]!.updatedAt).getTime(),
    );
    expect(await service.getProgress({ userId: USER_A }, { limit: 1 })).toHaveLength(1);
    expect(await service.getProgress({ userId: USER_A }, { limit: 999 })).toHaveLength(2);
    expect(await service.getProgress({ userId: USER_A }, { limit: 0 })).toHaveLength(1);
  });

  it("progress upserts write NO audit entries (D2.14-2)", async () => {
    const before = audit.entries.length;
    await service.upsertProgress(
      { userId: USER_A },
      { contentRef: "44444444-4444-4444-8444-444444444444", positionSeconds: 42 },
    );
    expect(audit.entries).toHaveLength(before);
  });
});


// ---------------------------------------------------------------------------
// Stage 2.18 - NOTIFICATIONS (D2.18-SELECT, D2.18-N1..N5, D2.18-P1..P3)
// ---------------------------------------------------------------------------

describe("notifications (Stage 2.18)", () => {
  const OWNER = "11111111-1111-4111-8111-111111111111";
  const ORG = "22222222-2222-4222-8222-222222222222";
  const notifyInput = (eventId: string): NewNotificationInput => ({
    orgId: ORG,
    audienceUserId: OWNER,
    kind: "conversation_reply",
    sourceKind: "conversation",
    sourceRef: "33333333-3333-4333-8333-333333333333",
    eventId,
    title: "New reply",
    body: "Your conversation has a new reply.",
  });

  it("recordNotification records a resolved notification (consumer write path)", async () => {
    const result = await service.recordNotification({
      kind: "notify",
      notification: notifyInput("evt-1"),
    });
    expect(result).toMatchObject({ ok: true, value: { kind: "recorded" } });
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0]!.eventId).toBe("evt-1");
    expect(store.notifications[0]!.audienceUserId).toBe(OWNER);
  });

  it("D2.18-P1: duplicate eventId is a silent noop_duplicate - no second row", async () => {
    await service.recordNotification({ kind: "notify", notification: notifyInput("evt-dup") });
    const before = store.notifications.length;
    const replay = await service.recordNotification({
      kind: "notify",
      notification: notifyInput("evt-dup"),
    });
    expect(replay).toMatchObject({ ok: true, value: { kind: "noop_duplicate" } });
    expect(store.notifications).toHaveLength(before);
  });

  it("D2.18-P3: first insert writes exactly one same-tx audit row; replay adds none", async () => {
    await service.recordNotification({ kind: "notify", notification: notifyInput("evt-a") });
    expect(audit.entries).toEqual([
      { action: "audience.notification_recorded", subjectId: store.notifications[0]!.id },
    ]);
    const after = audit.entries.length;
    await service.recordNotification({ kind: "notify", notification: notifyInput("evt-a") });
    expect(audit.entries).toHaveLength(after);
  });

  it("self-send resolution is suppressed without any write or audit", async () => {
    const before = store.notifications.length;
    const result = await service.recordNotification({ kind: "suppress_self_send" });
    expect(result).toMatchObject({ ok: true, value: { kind: "noop_duplicate" } });
    expect(store.notifications).toHaveLength(before);
    expect(audit.entries).toHaveLength(0);
  });

  it("missing source rows and malformed events return typed errors, never throw", async () => {
    const missing = await service.recordNotification({ kind: "noop_missing" });
    expect(missing.ok).toBe(false);
    const invalid = await service.recordNotification({
      kind: "invalid_event",
      message: "payload malformed",
    });
    expect(invalid.ok).toBe(false);
    expect(store.notifications).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it("recipient/org id validation fails closed on non-uuid authority fields", async () => {
    const bad = notifyInput("evt-bad");
    const result = await service.recordNotification({
      kind: "notify",
      notification: { ...bad, audienceUserId: "not-a-uuid" },
    });
    expect(result.ok).toBe(false);
    expect(store.notifications).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it("listNotifications is owner-scoped, newest first, and bounded", async () => {
    for (let i = 0; i < 5; i++) {
      await service.recordNotification({
        kind: "notify",
        notification: notifyInput(`evt-list-${i}`),
      });
    }
    const other = await service.listNotifications({ userId: "99999999-9999-4999-8999-999999999999" });
    expect(other).toHaveLength(0);
    const rows = await service.listNotifications({ userId: OWNER });
    expect(rows).toHaveLength(5);
    const bounded = await service.listNotifications({ userId: OWNER }, { limit: 2 });
    expect(bounded).toHaveLength(2);
  });

  it("D2.18-N5: unreadNotifications is the DERIVED count of read_at IS NULL", async () => {
    for (let i = 0; i < 3; i++) {
      await service.recordNotification({
        kind: "notify",
        notification: notifyInput(`evt-unread-${i}`),
      });
    }
    expect(await service.unreadNotifications({ userId: OWNER })).toBe(3);
    await service.markNotificationsRead({ userId: OWNER }, { all: true });
    expect(await service.unreadNotifications({ userId: OWNER })).toBe(0);
  });

  it("D2.18-P2: mark-read { all: true } affects only the authenticated owner", async () => {
    const otherUser = "99999999-9999-4999-8999-999999999999";
    await service.recordNotification({ kind: "notify", notification: notifyInput("evt-o1") });
    // Seed a foreign-owner row directly (the owner commands cannot create it).
    const repo = makeRepo(store, audit);
    await repo.insertNotificationIfAbsent({
      orgId: ORG,
      audienceUserId: otherUser,
      kind: "conversation_reply",
      sourceKind: "conversation",
      sourceRef: null,
      eventId: "evt-foreign",
      title: "Foreign",
      body: null,
    });
    const result = await service.markNotificationsRead({ userId: OWNER }, { all: true });
    expect(result).toMatchObject({ ok: true, value: { updated: 1, unreadCount: 0 } });
    const foreign = store.notifications.find((n) => n.eventId === "evt-foreign");
    expect(foreign?.readAt).toBeNull();
  });

  it("D2.18-P2: mark-read { ids } ignores foreign-owner uuids and is idempotent", async () => {
    await service.recordNotification({ kind: "notify", notification: notifyInput("evt-m1") });
    const id = store.notifications[0]!.id;
    const first = await service.markNotificationsRead({ userId: OWNER }, { ids: [id, "88888888-8888-4888-8888-888888888888"] });
    expect(first).toMatchObject({ ok: true, value: { updated: 1, unreadCount: 0 } });
    const second = await service.markNotificationsRead({ userId: OWNER }, { ids: [id] });
    expect(second).toMatchObject({ ok: true, value: { updated: 0, unreadCount: 0 } });
  });

  it("owner read commands write NO audit (D2.14-2 precedent)", async () => {
    await service.recordNotification({ kind: "notify", notification: notifyInput("evt-noaudit") });
    const before = audit.entries.length;
    await service.listNotifications({ userId: OWNER });
    await service.unreadNotifications({ userId: OWNER });
    await service.markNotificationsRead({ userId: OWNER }, { all: true });
    expect(audit.entries).toHaveLength(before);
  });
});
