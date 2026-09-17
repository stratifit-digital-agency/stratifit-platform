import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  StorageOperationError,
  SupabaseStorage,
  assertStorageConfig,
  type SupabaseStorageClient,
} from "./supabase-adapter";

/**
 * Stage 2.5 adapter suite (decisions D2.5-1..D2.5-4). Uses a fake injected
 * client — no network, no real credentials anywhere in this file.
 */
const ORG = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const ID = "11111111-2222-4333-8444-555555555555";
const KEY = `org/${ORG}/assets/${ID}`;
const BYTES = new Uint8Array([9, 8, 7]);
const CONFIG = {
  url: "https://example.supabase.co",
  serviceKey: "test-only-not-a-real-credential",
  bucket: "stratifit-media-prod",
};

/** The operation seam this adapter uses on the bucket handle. */
interface BucketOps {
  upload(path: string, body: Uint8Array, options: { contentType: string }): Promise<{ error: unknown }>;
  download(path: string): Promise<{ data: Blob | null; error: unknown }>;
  createSignedUrl(path: string, expiresInSeconds: number): Promise<{ data: { signedUrl?: string } | null; error: unknown }>;
  remove(paths: string[]): Promise<{ error: unknown }>;
}

type BucketOverride = Partial<Record<keyof BucketOps, unknown>>;

const fakeClient = (overrides: BucketOverride = {}) => {
  const bucket = {
    upload: vi.fn(async () => ({ error: null })),
    download: vi.fn(async () => ({
      data: new Blob([BYTES], { type: "video/mp4" }),
      error: null,
    })),
    createSignedUrl: vi.fn(async (_p: string, e: number) => ({
      data: { signedUrl: `https://example.supabase.co/storage/v1/object/sign/...?exp=${e}` },
      error: null,
    })),
    remove: vi.fn(async () => ({ error: null })),
  };
  if (overrides.upload) bucket.upload = overrides.upload as never;
  if (overrides.download) bucket.download = overrides.download as never;
  if (overrides.createSignedUrl) bucket.createSignedUrl = overrides.createSignedUrl as never;
  if (overrides.remove) bucket.remove = overrides.remove as never;
  return { from: vi.fn(() => bucket), bucket } as unknown as SupabaseStorageClient & {
    bucket: BucketOps;
  };
};

const make = (overrides: BucketOverride = {}) => {
  const fake = fakeClient(overrides);
  const storage = new SupabaseStorage(CONFIG, () => fake as unknown as SupabaseStorageClient);
  return { storage, fake };
};

describe("configuration", () => {
  it("fails closed on missing/blank url, serviceKey, or bucket", () => {
    expect(() => assertStorageConfig({ url: "", serviceKey: "k", bucket: "b" })).toThrow(
      StorageOperationError,
    );
    expect(() => assertStorageConfig({ url: "https://x.co", serviceKey: "", bucket: "b" })).toThrow(
      StorageOperationError,
    );
    expect(() => assertStorageConfig({ url: "https://x.co", serviceKey: "k", bucket: "  " })).toThrow(
      StorageOperationError,
    );
    expect(() => assertStorageConfig({ url: "not-a-url", serviceKey: "k", bucket: "b" })).toThrow(
      StorageOperationError,
    );
  });

  it("constructor throws before any client is created when config is invalid", () => {
    expect(
      () =>
        new SupabaseStorage(
          { url: "https://x.co", serviceKey: "", bucket: "b" },
          () => fakeClient() as unknown as SupabaseStorageClient,
        ),
    ).toThrow(StorageOperationError);
  });
});

describe("contract operations", () => {
  it("put uploads with contentType and returns the key", async () => {
    const { storage, fake } = make();
    await expect(storage.put({ key: KEY, bytes: BYTES, contentType: "video/mp4" })).resolves.toEqual({
      key: KEY,
    });
    expect(fake.bucket.upload).toHaveBeenCalledWith(KEY, BYTES, { contentType: "video/mp4" });
  });

  it("get downloads bytes and preserves contentType", async () => {
    const { storage } = make();
    const out = await storage.get(KEY);
    expect(out?.bytes).toEqual(BYTES);
    expect(out?.contentType).toBe("video/mp4");
  });

  it("get returns null when the object is absent (no error)", async () => {
    const { storage } = make({
      download: async () => ({ data: null, error: null }),
    });
    expect(await storage.get(KEY)).toBeNull();
  });

  it("delete forwards the key for removal", async () => {
    const { storage, fake } = make();
    await expect(storage.delete(KEY)).resolves.toBeUndefined();
    expect(fake.bucket.remove).toHaveBeenCalledWith([KEY]);
  });
});

describe("signed URLs (D2.5-3/D2.5-4)", () => {
  it("defaults expiry to 3600 seconds", async () => {
    const { storage, fake } = make();
    await storage.signedUrl(KEY);
    expect(fake.bucket.createSignedUrl).toHaveBeenCalledWith(KEY, 3600);
    expect(DEFAULT_SIGNED_URL_EXPIRY_SECONDS).toBe(3600);
  });

  it("passes a caller-supplied expiry through", async () => {
    const { storage, fake } = make();
    await storage.signedUrl(KEY, 120);
    expect(fake.bucket.createSignedUrl).toHaveBeenCalledWith(KEY, 120);
  });

  it("fails closed on invalid expiry values", async () => {
    const { storage } = make();
    await expect(storage.signedUrl(KEY, 0)).rejects.toThrow(StorageOperationError);
    await expect(storage.signedUrl(KEY, -5)).rejects.toThrow(StorageOperationError);
    await expect(storage.signedUrl(KEY, 1.5)).rejects.toThrow(StorageOperationError);
    await expect(storage.signedUrl(KEY, 604801)).rejects.toThrow(StorageOperationError);
  });
});

describe("classified errors without secret leakage", () => {
  it("wraps provider errors per operation", async () => {
    const { storage } = make({
      upload: async () => ({ error: new Error("bucket not found") }),
    });
    await expect(storage.put({ key: KEY, bytes: BYTES, contentType: "x" })).rejects.toMatchObject({
      name: "StorageOperationError",
      operation: "put",
    });
  });

  it("get/signedUrl/delete failures are classified too", async () => {
    const { storage } = make({ download: async () => ({ data: null, error: new Error("boom") }) });
    await expect(storage.get(KEY)).rejects.toMatchObject({ operation: "get" });

    const { storage: s2 } = make({
      createSignedUrl: async () => ({ data: null, error: new Error("nope") }),
    });
    await expect(s2.signedUrl(KEY)).rejects.toMatchObject({ operation: "signedUrl" });

    const { storage: s3 } = make({ remove: async () => ({ error: new Error("denied") }) });
    await expect(s3.delete(KEY)).rejects.toMatchObject({ operation: "delete" });
  });

  it("error messages never contain the service key or credential-bearing URLs", async () => {
    const { storage } = make({
      upload: async () => ({ error: new Error("bucket not found") }),
    });
    const error = await storage
      .put({ key: KEY, bytes: BYTES, contentType: "x" })
      .catch((e: unknown) => e as Error);
    expect(String(error)).not.toContain(CONFIG.serviceKey);
    expect(String(error)).not.toContain("Authorization");
    expect(String(error)).not.toContain("serviceKey");
  });

  it("rejects invalid object keys through the shared key policy", async () => {
    const { storage } = make();
    await expect(
      storage.put({ key: "../evil", bytes: BYTES, contentType: "x" }),
    ).rejects.toMatchObject({ name: "StorageOperationError" });
    await expect(storage.get("org/not-a-uuid/assets/x")).rejects.toThrow(StorageOperationError);
    await expect(storage.signedUrl(`org/${ORG}/secrets/${ID}`)).rejects.toThrow(
      StorageOperationError,
    );
  });
});

describe("verifyBucketAccess (concrete-only)", () => {
  it("passes when the provider signs a probe URL", async () => {
    const { storage } = make();
    await expect(storage.verifyBucketAccess()).resolves.toBeUndefined();
  });

  it("fails classified when the bucket is unavailable", async () => {
    const { storage } = make({
      createSignedUrl: async () => ({ data: null, error: new Error("Bucket not found") }),
    });
    await expect(storage.verifyBucketAccess()).rejects.toMatchObject({
      name: "StorageOperationError",
      operation: "verifyBucketAccess",
    });
  });
});
