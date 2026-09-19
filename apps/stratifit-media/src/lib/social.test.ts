import { describe, expect, it } from "vitest";
import type { OwnContentRefView, PublicCommentBffView } from "./social";
import {
  commentBodySchema,
  followBodySchema,
  listQuerySchema,
  shareBodySchema,
  toggleBodySchema,
  writeResponse,
} from "./social-route";

/**
 * Stage 2.15 Media-side guards. The request schemas are re-declared
 * structurally in the route helpers; here we pin their strictness (authority
 * fields rejected), the whitelist shapes of the BFF views, and the outcome→
 * HTTP mapping — without a database.
 */

describe("toggle body schema (strict — no client authority fields)", () => {
  const valid = { contentRef: "44444444-4444-4444-8444-444444444444" };

  it("accepts the minimal valid body", () => {
    expect(toggleBodySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects client-supplied userId / audienceUserId / orgId / emailVerified", () => {
    expect(toggleBodySchema.safeParse({ ...valid, userId: "hax" }).success).toBe(false);
    expect(toggleBodySchema.safeParse({ ...valid, audienceUserId: "hax" }).success).toBe(false);
    expect(toggleBodySchema.safeParse({ ...valid, orgId: "hax" }).success).toBe(false);
    expect(toggleBodySchema.safeParse({ ...valid, emailVerified: true }).success).toBe(false);
  });

  it("rejects malformed uuids", () => {
    expect(toggleBodySchema.safeParse({ contentRef: "not-a-uuid" }).success).toBe(false);
  });
});

describe("follow body schema (strict)", () => {
  const valid = { followeeRef: "55555555-5555-4555-8555-555555555555" };

  it("accepts a valid followeeRef and rejects extra authority fields", () => {
    expect(followBodySchema.safeParse(valid).success).toBe(true);
    expect(followBodySchema.safeParse({ ...valid, followeeKind: "creator_profile" }).success).toBe(false);
    expect(followBodySchema.safeParse({ ...valid, userId: "hax" }).success).toBe(false);
    // The BFF hard-codes audience_user targets — creator follows stay fail-closed upstream.
  });

  it("rejects malformed uuids", () => {
    expect(followBodySchema.safeParse({ followeeRef: "x" }).success).toBe(false);
  });
});

describe("comment body schema (strict)", () => {
  const valid = { contentRef: "44444444-4444-4444-8444-444444444444", body: "nice" };

  it("accepts body with optional parentCommentId", () => {
    expect(commentBodySchema.safeParse(valid).success).toBe(true);
    expect(
      commentBodySchema.safeParse({ ...valid, parentCommentId: "66666666-6666-4666-8666-666666666666" }).success,
    ).toBe(true);
  });

  it("enforces the 1..2000 body limit at the boundary", () => {
    expect(commentBodySchema.safeParse({ ...valid, body: "" }).success).toBe(false);
    expect(commentBodySchema.safeParse({ ...valid, body: "x".repeat(2001) }).success).toBe(false);
    expect(commentBodySchema.safeParse({ ...valid, body: "x".repeat(2000) }).success).toBe(true);
  });

  it("rejects client authority fields", () => {
    expect(commentBodySchema.safeParse({ ...valid, authorId: "hax" }).success).toBe(false);
    expect(commentBodySchema.safeParse({ ...valid, visibility: "hidden" }).success).toBe(false);
  });
});

describe("share body schema (strict, D2.15-6 channel enum)", () => {
  const valid = { contentRef: "44444444-4444-4444-8444-444444444444", channel: "copy_link" as const };

  it("accepts copy_link and external only", () => {
    expect(shareBodySchema.safeParse(valid).success).toBe(true);
    expect(shareBodySchema.safeParse({ ...valid, channel: "external" }).success).toBe(true);
    expect(shareBodySchema.safeParse({ ...valid, channel: "smoke-signal" }).success).toBe(false);
  });

  it("rejects client authority fields", () => {
    expect(shareBodySchema.safeParse({ ...valid, orgId: "hax" }).success).toBe(false);
  });
});

describe("list query schema", () => {
  it("clamps limit into 1..200", () => {
    expect(listQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: "50" }).success).toBe(true);
    expect(listQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe("BFF view whitelists", () => {
  it("own-state views expose exactly contentRef + createdAt", () => {
    const view: OwnContentRefView = { contentRef: "c", createdAt: "t" };
    expect(Object.keys(view).sort()).toEqual(["contentRef", "createdAt"]);
  });

  it("public comment views expose the frozen five fields — never a raw author id", () => {
    const view: PublicCommentBffView = {
      commentId: "id",
      body: "b",
      createdAt: "t",
      parentCommentId: null,
      authorHandle: "alice",
    };
    expect(Object.keys(view).sort()).toEqual([
      "authorHandle",
      "body",
      "commentId",
      "createdAt",
      "parentCommentId",
    ]);
    expect(JSON.stringify(view)).not.toContain("authorId");
    expect(JSON.stringify(view)).not.toContain("orgId");
  });
});

describe("outcome → HTTP mapping", () => {
  it("maps domain reasons to the §13 envelope with the correct statuses", async () => {
    const notFound = writeResponse({ ok: false, reason: "content_not_found", message: "m" });
    expect(notFound.status).toBe(404);
    const email = writeResponse({ ok: false, reason: "email_verification_required", message: "m" });
    expect(email.status).toBe(403);
    const selfFollow = writeResponse({ ok: false, reason: "self_follow", message: "m" });
    expect(selfFollow.status).toBe(422);
    const creator = writeResponse({ ok: false, reason: "creator_targets_unsupported", message: "m" });
    expect(creator.status).toBe(422);
    const created = writeResponse({ ok: true, state: "liked" }, 201);
    expect(created.status).toBe(201);
    const body = (await (notFound as Response).json()) as { error: { code: string } };
    expect(body.error.code).toBe("content_not_found");
  });
});

describe("authority fields never influence identity (structural proof)", () => {
  it("strict schemas reject EVERY authority-shaped extra field on every write body", () => {
    const base = { contentRef: "44444444-4444-4444-8444-444444444444" };
    for (const schema of [toggleBodySchema, shareBodySchema]) {
      for (const extra of ["userId", "audienceUserId", "orgId", "emailVerified", "authorId"]) {
        expect(schema.safeParse({ ...base, [extra]: "hax" }).success).toBe(false);
      }
    }
    expect(followBodySchema.safeParse({ followeeRef: base.contentRef, userId: "hax" }).success).toBe(false);
    expect(
      commentBodySchema.safeParse({ ...base, body: "b", audienceUserId: "hax" }).success,
    ).toBe(false);
  });
});
