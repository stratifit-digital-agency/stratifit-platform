import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDiskStorage, createStorageFromEnv } from "./provider";
import { SupabaseStorage } from "./supabase-adapter";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("LocalDiskStorage", () => {
  it("round-trips objects", async () => {
    dir = await mkdtemp(join(tmpdir(), "stratifit-store-"));
    const storage = new LocalDiskStorage(dir);
    await storage.put({ key: "a/b.bin", bytes: new Uint8Array([1, 2, 3]), contentType: "application/octet-stream" });
    const out = await storage.get("a/b.bin");
    expect(out?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null for missing keys", async () => {
    dir = await mkdtemp(join(tmpdir(), "stratifit-store-"));
    const storage = new LocalDiskStorage(dir);
    expect(await storage.get("missing")).toBeNull();
  });

  it("rejects path traversal", async () => {
    dir = await mkdtemp(join(tmpdir(), "stratifit-store-"));
    const storage = new LocalDiskStorage(dir);
    await expect(storage.put({ key: "../evil", bytes: new Uint8Array(), contentType: "x" })).rejects.toThrow();
  });
});

describe("createStorageFromEnv", () => {
  it("defaults to the local provider", () => {
    const storage = createStorageFromEnv({} as NodeJS.ProcessEnv);
    expect(storage).toBeInstanceOf(LocalDiskStorage);
  });

  it("selects the explicit local provider with its root", async () => {
    dir = await mkdtemp(join(tmpdir(), "stratifit-store-"));
    const storage = createStorageFromEnv({
      STORAGE_PROVIDER: "local",
      STORAGE_LOCAL_ROOT: dir,
    } as NodeJS.ProcessEnv);
    expect(storage).toBeInstanceOf(LocalDiskStorage);
    await expect(storage.put({ key: "f.bin", bytes: new Uint8Array([1]), contentType: "x" })).resolves.toEqual({ key: "f.bin" });
  });

  it("selects SupabaseStorage when STORAGE_PROVIDER=supabase (no network at construction)", () => {
    const storage = createStorageFromEnv({
      STORAGE_PROVIDER: "supabase",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-real-credential",
      SUPABASE_STORAGE_BUCKET: "stratifit-media-prod",
    } as NodeJS.ProcessEnv);
    expect(storage).toBeInstanceOf(SupabaseStorage);
  });

  it("falls back to NEXT_PUBLIC_SUPABASE_URL for the project URL (public URL, not a credential)", () => {
    const storage = createStorageFromEnv({
      STORAGE_PROVIDER: "supabase",
      NEXT_PUBLIC_SUPABASE_URL: "https://fallback.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-real-credential",
      SUPABASE_STORAGE_BUCKET: "stratifit-media-prod",
    } as NodeJS.ProcessEnv);
    expect(storage).toBeInstanceOf(SupabaseStorage);
  });

  it("FAILS CLOSED when Supabase configuration is missing — never a silent local fallback", () => {
    expect(() =>
      createStorageFromEnv({ STORAGE_PROVIDER: "supabase" } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      createStorageFromEnv({
        STORAGE_PROVIDER: "supabase",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_STORAGE_BUCKET: "b",
      } as NodeJS.ProcessEnv),
    ).toThrow(); // missing service key
    expect(() =>
      createStorageFromEnv({
        STORAGE_PROVIDER: "supabase",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-real-credential",
      } as NodeJS.ProcessEnv),
    ).toThrow(); // missing bucket
  });

  it("rejects unknown providers", () => {
    expect(() =>
      createStorageFromEnv({ STORAGE_PROVIDER: "gcs" } as NodeJS.ProcessEnv),
    ).toThrow(/unknown STORAGE_PROVIDER/);
  });
});
