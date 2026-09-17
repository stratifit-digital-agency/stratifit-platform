import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStorageKey } from "./keys";
import { SupabaseStorage, type SupabaseStorageConfig } from "./supabase-adapter";

/**
 * Stage 2.5 GATED live test (approved optional item).
 *
 * Runs ONLY when the git-ignored root .env provides a complete server-side
 * storage configuration:
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY +
 *   SUPABASE_STORAGE_BUCKET + STORAGE_TEST_ORG_ID
 *
 * Requires the private bucket to already exist (bucket creation is a manual
 * platform operation — the adapter never creates buckets). Flow:
 *   verifyBucketAccess -> put -> signedUrl -> get -> delete
 * Credentials are read from the environment at runtime and NEVER printed,
 * logged, or embedded in this file. Safely skipped when config is absent
 * (the adapter is constructed lazily so collection never touches credentials).
 */
const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const read = (name: string): string | undefined =>
  hasEnv
    ? readFileSync(envPath, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim()
    : undefined;

const config: SupabaseStorageConfig | null =
  hasEnv &&
  (read("SUPABASE_URL") || read("NEXT_PUBLIC_SUPABASE_URL")) &&
  read("SUPABASE_SERVICE_ROLE_KEY") &&
  read("SUPABASE_STORAGE_BUCKET") &&
  read("STORAGE_TEST_ORG_ID")
    ? {
        url: (read("SUPABASE_URL") || read("NEXT_PUBLIC_SUPABASE_URL"))!,
        serviceKey: read("SUPABASE_SERVICE_ROLE_KEY")!,
        bucket: read("SUPABASE_STORAGE_BUCKET")!,
      }
    : null;

const ORG_ID = read("STORAGE_TEST_ORG_ID") ?? "";

const d = config && ORG_ID ? describe : describe.skip;

d("storage live (gated: real private bucket + runtime credentials)", () => {
  // Lazy construction: the adapter and probe key are created only when the
  // suite actually runs (never during skip-collection, never without
  // credentials).
  let storage: SupabaseStorage;
  let key: string;
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);

  beforeAll(() => {
    storage = new SupabaseStorage(config!);
    // Fresh probe object per run; key comes from the approved policy so the
    // adapter's own validation is exercised too.
    key = `org/${ORG_ID}/assets/${randomUUID()}`;
    parseStorageKey(key); // must be policy-valid by construction
  });

  it("verifies bucket access (fail-closed when the bucket is missing)", async () => {
    await expect(storage.verifyBucketAccess()).resolves.toBeUndefined();
  });

  it("round-trips put -> signedUrl -> get -> delete against the real private bucket", async () => {
    await expect(storage.put({ key, bytes, contentType: "application/octet-stream" })).resolves.toEqual({
      key,
    });

    const signedUrl = await storage.signedUrl(key, 120);
    expect(typeof signedUrl).toBe("string");
    expect(signedUrl.length).toBeGreaterThan(0);
    // Never log the signed URL — it carries access material.

    const out = await storage.get(key);
    expect(out?.bytes).toEqual(bytes);
    expect(out?.key).toBe(key);

    await expect(storage.delete(key)).resolves.toBeUndefined();
    await expect(storage.get(key)).resolves.toBeNull();
  });

  afterAll(async () => {
    // Best-effort cleanup if a later step failed mid-flow.
    if (storage) await storage.delete(key).catch(() => undefined);
  });
});
