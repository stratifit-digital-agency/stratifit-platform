import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDiskStorage } from "./provider";

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
