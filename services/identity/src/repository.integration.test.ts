import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync, existsSync } from "node:fs";
import { createDrizzleIdentityRepository } from "./repository";
import { audienceUsers, organizations } from "@stratifit/database";

/**
 * Live integration test for the durable repository (JIT upsert + race safety
 * via the unique constraint). Runs ONLY when a git-ignored root .env provides
 * DATABASE_URL; the unit matrix in resolution.test.ts covers all semantics
 * with fakes, so this file stays skipped in clean checkouts/CI.
 */
const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const databaseUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;

const d = databaseUrl ? describe : describe.skip;

d("drizzle identity repository (live, gated)", () => {
  it("JIT-upserts audience users bound to the default org and mirrors provider state", async () => {
    const repo = createDrizzleIdentityRepository({ databaseUrl: databaseUrl as string });
    const subject = `it-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const first = await repo.upsertAudienceUser({ authSubjectRef: subject, email: "it@example.com", emailVerified: false });
    const orgs = await repo.db.select({ id: organizations.id }).from(organizations);
    expect(first.orgId).toBe(orgs[0]?.id);
    expect(first.emailVerified).toBe(false);

    // Mirror refresh on re-resolution (verification completed upstream).
    const second = await repo.upsertAudienceUser({ authSubjectRef: subject, email: "it@example.com", emailVerified: true });
    expect(second.id).toBe(first.id);
    expect(second.emailVerified).toBe(true);

    const found = await repo.findAudienceBySubject(subject);
    expect(found?.emailVerified).toBe(true);
    await repo.db.delete(audienceUsers).where(eq(audienceUsers.authSubjectRef, subject));
  });
});
