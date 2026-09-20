/**
 * Analytics-intake unit tests (Stage 2.19).
 *
 * Covers the frozen order (validate -> rate-limit -> server-side resolution
 * -> insert -> POST-insert emit) plus Cases A-D and the security matrix:
 * validation gates, both limiter keys, fail-closed content resolution,
 * session hashing, idempotent replay, and no-emit-on-failure paths.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DomainEventEnvelope } from "@stratifit/contracts";
import { createAnalyticsService, hashSessionId } from "./service";
import type {
  AnalyticsEventRecord,
  AnalyticsProperties,
  AnalyticsRateLimiter,
  AnalyticsRepository,
  NewAnalyticsEventRow,
} from "./types";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

interface FakeRepo {
  repository: AnalyticsRepository;
  rows: AnalyticsEventRecord[];
  inserts: string[];
  failNextInsert: boolean;
}

const createFakeRepo = (published: Array<{ id: string; orgId: string }> = []): FakeRepo => {
  const state: FakeRepo = {
    repository: null as unknown as AnalyticsRepository,
    rows: [],
    inserts: [],
    failNextInsert: false,
  };
  const seen = new Set<string>();
  state.repository = {
    insertEventIfAbsent: async (input: NewAnalyticsEventRow) => {
      state.inserts.push(input.ingestEventId);
      if (state.failNextInsert) {
        state.failNextInsert = false;
        throw new Error("boom: insert failed");
      }
      if (seen.has(input.ingestEventId)) return null;
      seen.add(input.ingestEventId);
      const row: AnalyticsEventRecord = {
        id: "row-" + (state.rows.length + 1),
        eventType: input.eventType,
        contentRef: input.contentRef,
        orgId: input.orgId,
        audienceUserId: input.audienceUserId,
        sessionHash: input.sessionHash,
        serverTs: new Date("2026-09-20T12:00:00.000Z"),
        ingestEventId: input.ingestEventId,
      };
      state.rows.push(row);
      return row;
    },
    findPublishedContentRef: async (contentRef: string) =>
      published.find((c) => c.id === contentRef) ?? null,
  };
  return state;
};

/** Fixed-window fake: N allowed consumes per key, then denies. */
const createFakeLimiter = (
  limits: Record<string, number>,
): AnalyticsRateLimiter & { counts: Map<string, number> } => {
  const counts = new Map<string, number>();
  return {
    counts,
    consume: async (key: string) => {
      const used = counts.get(key) ?? 0;
      if (used >= (limits[key] ?? limits["*"] ?? Infinity)) return false;
      counts.set(key, used + 1);
      return true;
    },
  };
};

interface Harness {
  calls: string[]; // "insert" and "emit" in exact invocation order
  envelopes: DomainEventEnvelope[];
}

const createService = (opts?: {
  published?: Array<{ id: string; orgId: string }>;
  limit?: number;
}) => {
  const repo = createFakeRepo(opts?.published);
  const limiter = createFakeLimiter(opts?.limit !== undefined ? { "*": opts.limit } : {});
  const h: Harness = { calls: [], envelopes: [] };
  const service = createAnalyticsService({
    repository: repo.repository,
    rateLimiter: limiter,
    publisher: async (envelope) => {
      h.calls.push("emit");
      h.envelopes.push(envelope);
    },
  });
  const inner = repo.repository.insertEventIfAbsent.bind(repo.repository);
  repo.repository.insertEventIfAbsent = async (input) => {
    h.calls.push("insert");
    return inner(input);
  };
  return { service, repo, limiter, h };
};

const baseInput = {
  eventType: "content_view" as const,
  contentRef: null,
  audienceUserId: null,
  sessionId: "session-abcdef123456",
  sourceIp: "203.0.113.9",
  properties: null,
  clientTs: null,
  eventId: null,
};

// ---------------------------------------------------------------------------
// Case A - happy path: insert commits BEFORE the event is emitted
// ---------------------------------------------------------------------------

describe("recordEvent - Case A ordering and envelope", () => {
  it("inserts first, then emits analytics.received post-insert", async () => {
    const { service, repo, h } = createService();
    const res = await service.recordEvent(baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.calls).toEqual(["insert", "emit"]);
    expect(repo.rows).toHaveLength(1);
    expect(h.envelopes).toHaveLength(1);
  });

  it("envelope.eventId === row.ingest_event_id (D2.19-A2 relationship)", async () => {
    const { service, repo, h } = createService();
    await service.recordEvent(baseInput);
    const row = repo.rows[0]!;
    expect(h.envelopes[0]!.eventId).toBe(row.ingestEventId);
  });

  it("envelope name/correlation/payload mirror the committed row", async () => {
    const contentId = "11111111-1111-4111-8111-111111111111";
    const { service, h } = createService({
      published: [{ id: contentId, orgId: "org-1" }],
    });
    await service.recordEvent({
      ...baseInput,
      eventType: "content_progress",
      contentRef: contentId,
      audienceUserId: "22222222-2222-4222-8222-222222222222",
    });
    const env = h.envelopes[0]!;
    expect(env.name).toBe("analytics.received");
    expect(env.correlation).toEqual({ organizationId: "org-1" });
    expect(env.payload).toEqual({
      eventType: "content_progress",
      contentRef: contentId,
      sessionHash: sha("session-abcdef123456"),
    });
  });

  it("anonymous accepted with NO contentRef -> null org, envelope correlation empty", async () => {
    const { service, h } = createService();
    const res = await service.recordEvent(baseInput);
    expect(res.ok).toBe(true);
    expect(h.envelopes[0]!.correlation).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Case B / C / D - failure and replay semantics
// ---------------------------------------------------------------------------

describe("recordEvent - Cases B, C, D", () => {
  it("Case B: insert failure -> error result, NOTHING emitted", async () => {
    const { service, repo, h } = createService();
    repo.failNextInsert = true;
    const res = await service.recordEvent(baseInput);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe("invalid_event");
    expect(h.calls).toEqual(["insert"]);
    expect(h.envelopes).toHaveLength(0);
    expect(repo.rows).toHaveLength(0);
  });

  it("Case C: publisher failure propagates but the committed row is NOT rolled back", async () => {
    const repo = createFakeRepo();
    const limiter = createFakeLimiter({ "*": 100 });
    const service = createAnalyticsService({
      repository: repo.repository,
      rateLimiter: limiter,
      publisher: async () => {
        throw new Error("bus down");
      },
    });
    await expect(service.recordEvent(baseInput)).rejects.toThrow("bus down");
    expect(repo.rows).toHaveLength(1); // committed and retained
  });

  it("Case D: duplicate ingest_event_id -> deduped, no second row, NO re-emission", async () => {
    const { service, repo, h } = createService();
    const first = await service.recordEvent({ ...baseInput, eventId: "evt-1" });
    const second = await service.recordEvent({ ...baseInput, eventId: "evt-1" });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.outcome.deduped).toBe(true);
    expect(second.value.emitted).toBeNull();
    expect(repo.rows).toHaveLength(1);
    expect(h.envelopes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation gates (before any I/O)
// ---------------------------------------------------------------------------

describe("recordEvent - validation fail-closed gates", () => {
  const cases: Array<{ name: string; input: Record<string, unknown>; reason: string }> = [
    { name: "unknown eventType", input: { eventType: "page_view" }, reason: "invalid_event" },
    { name: "short sessionId", input: { sessionId: "short" }, reason: "invalid_event" },
    { name: "oversized sessionId", input: { sessionId: "x".repeat(129) }, reason: "invalid_event" },
    { name: "client audienceUserId", input: { audienceUserId: "not-a-uuid" }, reason: "invalid_event" },
    { name: "malformed contentRef", input: { contentRef: "zzz" }, reason: "invalid_event" },
    { name: "NaN clientTs", input: { clientTs: "not-a-date" }, reason: "invalid_event" },
    { name: "clientTs >1h in future", input: { clientTs: "2030-01-01T00:00:00.000Z" }, reason: "invalid_event" },
  ];
  for (const c of cases) {
    it("rejects: " + c.name + " (no limiter, no repo, no emit)", async () => {
      const { service, repo, limiter, h } = createService();
      const res = await service.recordEvent({ ...baseInput, ...c.input } as typeof baseInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.reason).toBe(c.reason);
      expect(limiter.counts.size).toBe(0);
      expect(repo.inserts).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
    });
  }

  it("rejects properties with more than 8 keys", async () => {
    const { service, repo } = createService();
    const properties: AnalyticsProperties = {};
    for (let i = 0; i < 9; i++) properties["k" + i] = i;
    const res = await service.recordEvent({ ...baseInput, properties });
    expect(res.ok).toBe(false);
    expect(repo.inserts).toHaveLength(0);
  });

  it("rejects disallowed property shapes (uppercase key, long value, object value)", async () => {
    for (const properties of [
      { BadKey: 1 },
      { long: "y".repeat(201) },
      { nested: { a: 1 } } as unknown as AnalyticsProperties,
    ]) {
      const { service, repo } = createService();
      const res = await service.recordEvent({ ...baseInput, properties });
      expect(res.ok).toBe(false);
      expect(repo.inserts).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (D2.19-A5)
// ---------------------------------------------------------------------------

describe("recordEvent - dual-key rate limiting", () => {
  it("ip key exhaustion -> rate_limited before any repo work", async () => {
    const { service, repo, limiter, h } = createService({ limit: 2 });
    for (let i = 0; i < 2; i++) {
      const res = await service.recordEvent({ ...baseInput, sessionId: "session-" + String(i).padEnd(12, "x") });
      expect(res.ok).toBe(true);
    }
    const third = await service.recordEvent({ ...baseInput, sessionId: "session-xxxxxxxxxxxx" });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.reason).toBe("rate_limited");
    expect(repo.inserts).toHaveLength(2);
    expect(h.calls.filter((c) => c === "emit")).toHaveLength(2);
    expect(limiter.counts.get("ip:203.0.113.9")).toBe(2);
  });

  it("session key exhaustion -> rate_limited even from a fresh ip", async () => {
    const { service, repo, limiter } = createService({ limit: 1 });
    const first = await service.recordEvent(baseInput);
    expect(first.ok).toBe(true);
    const second = await service.recordEvent({ ...baseInput, sourceIp: "198.51.100.7" });
    expect(second.ok).toBe(false);
    expect(repo.inserts).toHaveLength(1);
    expect(limiter.counts.get("sess:" + sha("session-abcdef123456"))).toBe(1);
  });

  it("keys are ip:<sourceIp> and sess:<sha256> ; null ip maps to ip:unknown", async () => {
    const { service, limiter } = createService();
    await service.recordEvent(baseInput);
    expect(limiter.counts.has("ip:203.0.113.9")).toBe(true);
    expect(limiter.counts.has("sess:" + sha("session-abcdef123456"))).toBe(true);
    await service.recordEvent({ ...baseInput, sourceIp: null, sessionId: "session-ffffffffffff" });
    expect(limiter.counts.has("ip:unknown")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server-side resolution, hashing, identity
// ---------------------------------------------------------------------------

describe("recordEvent - server-side resolution and privacy", () => {
  it("unknown contentRef -> content_not_found, no insert, no emit", async () => {
    const missing = "99999999-9999-4999-8999-999999999999";
    const { service, repo, h } = createService({ published: [] });
    const res = await service.recordEvent({ ...baseInput, contentRef: missing });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe("content_not_found");
    expect(repo.inserts).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it("published content resolves contentRef AND org server-side", async () => {
    const contentId = "11111111-1111-4111-8111-111111111111";
    const { service, repo } = createService({ published: [{ id: contentId, orgId: "org-7" }] });
    await service.recordEvent({ ...baseInput, contentRef: contentId });
    expect(repo.rows[0]!.contentRef).toBe(contentId);
    expect(repo.rows[0]!.orgId).toBe("org-7");
  });

  it("raw session id is NEVER persisted - only the 64-hex sha256", async () => {
    const { service, repo } = createService();
    await service.recordEvent(baseInput);
    expect(repo.rows[0]!.sessionHash).toBe(sha("session-abcdef123456"));
    expect(repo.rows[0]!.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(repo.rows)).not.toContain("session-abcdef123456");
  });

  it("hashSessionId is deterministic; sourceIp is never persisted", async () => {
    expect(hashSessionId("abc")).toBe(sha("abc"));
    const { service, repo } = createService();
    await service.recordEvent(baseInput);
    expect(JSON.stringify(repo.rows)).not.toContain("203.0.113.9");
  });

  it("anonymous (null audienceUserId) and identified rows are stored as given", async () => {
    const { service, repo } = createService();
    await service.recordEvent(baseInput);
    await service.recordEvent({
      ...baseInput,
      sessionId: "session-bbbbbbbbbbbb",
      audienceUserId: "22222222-2222-4222-8222-222222222222",
    });
    expect(repo.rows[0]!.audienceUserId).toBeNull();
    expect(repo.rows[1]!.audienceUserId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("client eventId is the idempotency key; null generates analytics_*", async () => {
    const { service, repo } = createService();
    await service.recordEvent({ ...baseInput, eventId: "client-key-1" });
    await service.recordEvent({ ...baseInput, sessionId: "session-cccccccccccc" });
    expect(repo.rows[0]!.ingestEventId).toBe("client-key-1");
    expect(repo.rows[1]!.ingestEventId).toMatch(/^analytics_/);
  });

  it("valid properties pass through; insert count tracks accepted events", async () => {
    const { service, repo } = createService();
    await service.recordEvent({ ...baseInput, properties: { duration_s: 42, complete: true } });
    await service.recordEvent({ ...baseInput, sessionId: "session-dddddddddddd", properties: null });
    expect(repo.rows[0]!.eventType).toBe("content_view");
    expect(repo.inserts).toHaveLength(2);
  });
});
