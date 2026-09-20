/**
 * Media analytics-lib guards (Stage 2.19, D2.19-A1..A6).
 *
 * Verifies the PUBLIC beacon boundary:
 *  - beaconSchema accept/reject matrix: every A1 shape rule + the strict
 *    unknown-field rejection + PII-shaped property keys;
 *  - buildBeaconInput NEVER trusts client authority fields: a client-
 *    supplied audienceUserId is ignored; the server-derived principal wins;
 *  - sourceIpOf derives transport metadata ONLY from x-forwarded-for with a
 *    strict shape (never a body field, never persisted downstream);
 *  - toBeaconOutcome serializes the whitelisted 202 fields only.
 */
import { describe, expect, it } from "vitest";
import { IP_LIMIT_PER_MINUTE, SESSION_LIMIT_PER_MINUTE } from "@stratifit/analytics";
import {
  beaconRateLimiter,
  beaconRateLimiterConfig,
  beaconSchema,
  buildBeaconInput,
  sourceIpOf,
  toBeaconOutcome,
} from "./analytics";

describe("beacon rate limiter composition (D2.19-A5 frozen budget)", () => {
  it("is 30 events / 60s per source-IP key and 60 events / 60s per session key", () => {
    expect(beaconRateLimiterConfig.windowMs).toBe(60_000);
    expect(beaconRateLimiterConfig.ipLimit).toBe(IP_LIMIT_PER_MINUTE);
    expect(beaconRateLimiterConfig.ipLimit).toBe(30);
    expect(beaconRateLimiterConfig.sessionLimit).toBe(SESSION_LIMIT_PER_MINUTE);
    expect(beaconRateLimiterConfig.sessionLimit).toBe(60);
  });

  it("consumes both key families through the shared factory", async () => {
    const ok = await beaconRateLimiter.consume("sess:composition-probe-not-a-real-hash");
    expect(ok).toBe(true);
  });
});

const req = (headers: Record<string, string> = {}): Request =>
  new Request("https://media.example.com/api/events/beacon", { headers });

const baseBody = {
  eventType: "content_view",
  sessionId: "session-abcdef123456",
} as const;

describe("beaconSchema (D2.19-A1, strict)", () => {
  it("accepts the minimal anonymous beacon", () => {
    const r = beaconSchema.safeParse({ ...baseBody });
    expect(r.success).toBe(true);
  });

  it("accepts a full beacon with all optional fields", () => {
    const r = beaconSchema.safeParse({
      ...baseBody,
      eventType: "content_progress",
      contentRef: "11111111-1111-4111-8111-111111111111",
      audienceUserId: "22222222-2222-4222-8222-222222222222",
      properties: { duration_s: 42, complete: false, note: "ok" },
      clientTs: "2026-09-20T12:00:00.000Z",
      eventId: "client-key-1",
    });
    expect(r.success).toBe(true);
  });

  it("accepts explicit nulls for optional fields", () => {
    const r = beaconSchema.safeParse({
      ...baseBody,
      contentRef: null,
      properties: null,
      clientTs: null,
      eventId: null,
    });
    expect(r.success).toBe(true);
  });

  const rejections: Array<[string, unknown]> = [
    ["unknown eventType", { ...baseBody, eventType: "page_view" }],
    ["missing sessionId", { eventType: "content_view" }],
    ["short sessionId", { ...baseBody, sessionId: "short" }],
    ["oversized sessionId", { ...baseBody, sessionId: "x".repeat(129) }],
    ["malformed contentRef", { ...baseBody, contentRef: "not-a-uuid" }],
    ["malformed clientTs", { ...baseBody, clientTs: "20th of September" }],
    ["oversized eventId", { ...baseBody, eventId: "k".repeat(129) }],
    [
      "property key with uppercase/PII shape (email)",
      { ...baseBody, properties: { email: "x@y.z" } },
    ],
    ["property value too long", { ...baseBody, properties: { note: "y".repeat(201) } }],
    ["property value object (nested)", { ...baseBody, properties: { nested: { a: 1 } } }],
    ["unknown top-level field (strict)", { ...baseBody, orgId: "org-1" }],
    ["unknown top-level field (operatorId)", { ...baseBody, operatorId: "op-1" }],
    ["unknown top-level field (organizationId)", { ...baseBody, organizationId: "org-1" }],
  ];
  for (const [name, body] of rejections) {
    it(`rejects: ${name}`, () => {
      expect(beaconSchema.safeParse(body).success).toBe(false);
    });
  }

  it("schema allows schema-conforming keys the SERVICE caps at 8 (service-side gate)", () => {
    // The 8-key cap is service-enforced; the schema enforces the per-key/per-
    // value shape. A body at the schema limit still reaches the service gate.
    const properties: Record<string, string> = {};
    const keys = ["aa","bb","cc","dd","ee","ff","gg","hh","ii","jj","kk","ll"];
    for (const k of keys) properties[k] = "v";
    const r = beaconSchema.safeParse({ ...baseBody, properties });
    expect(r.success).toBe(true); // schema passes; service rejects with invalid_event
  });

  it("rejects PII keys beyond the literal email probe (denied list sample)", () => {
    for (const key of ["phone", "first_name", "user_agent", "ssn"]) {
      const r = beaconSchema.safeParse({ ...baseBody, properties: { [key]: "x" } });
      expect(r.success).toBe(false);
    }
  });
});

describe("buildBeaconInput (D2.19-A3 identity server-derived)", () => {
  it("client-supplied audienceUserId is IGNORED for anonymous callers", () => {
    const body = beaconSchema.parse({
      ...baseBody,
      audienceUserId: "22222222-2222-4222-8222-222222222222",
    });
    const input = buildBeaconInput(body, null, req());
    expect(input.audienceUserId).toBeNull();
  });

  it("the SERVER-DERIVED principal overrides any client value", () => {
    const body = beaconSchema.parse({
      ...baseBody,
      audienceUserId: "22222222-2222-4222-8222-222222222222",
    });
    const input = buildBeaconInput(
      body,
      { userId: "33333333-3333-4333-8333-333333333333", emailVerified: true },
      req(),
    );
    expect(input.audienceUserId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("no client field can reach org/operator/authority positions", () => {
    const body = beaconSchema.parse(baseBody);
    const input = buildBeaconInput(body, null, req());
    expect(Object.keys(input).sort()).toEqual([
      "audienceUserId",
      "clientTs",
      "contentRef",
      "eventId",
      "eventType",
      "properties",
      "sessionId",
      "sourceIp",
    ]);
  });
});

describe("sourceIpOf (A5 server-derived transport metadata)", () => {
  it("derives the FIRST x-forwarded-for entry", () => {
    expect(sourceIpOf(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });

  it("returns null when the header is absent or malformed", () => {
    expect(sourceIpOf(req())).toBeNull();
    expect(sourceIpOf(req({ "x-forwarded-for": "not-an-ip" }))).toBeNull();
    expect(sourceIpOf(req({ "x-forwarded-for": "" }))).toBeNull();
  });
});

describe("toBeaconOutcome (whitelisted 202 body)", () => {
  it("serializes ONLY { accepted, eventId, deduped }", () => {
    const view = toBeaconOutcome({ accepted: true, eventId: "evt-1", deduped: false });
    expect(Object.keys(view).sort()).toEqual(["accepted", "deduped", "eventId"]);
    expect(view).toEqual({ accepted: true, eventId: "evt-1", deduped: false });
  });
});
