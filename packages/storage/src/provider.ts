import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Object-storage abstraction. Large media binaries (videos, audio, renders,
 * thumbnails) live here — never in PostgreSQL, which holds metadata and
 * references only.
 */

export interface StoredObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface StorageProvider {
  put(object: StoredObject): Promise<{ key: string }>;
  get(key: string): Promise<StoredObject | null>;
  /** Signed/controlled access URL; providers may scope by expiry. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

/** Local filesystem adapter for development and tests. */
export class LocalDiskStorage implements StorageProvider {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (key.includes("..")) throw new Error(`invalid storage key: ${key}`);
    return join(this.root, key);
  }

  async put(object: StoredObject): Promise<{ key: string }> {
    const path = this.resolve(object.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, object.bytes);
    return { key: object.key };
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const bytes = await readFile(this.resolve(key));
      return { key, bytes: new Uint8Array(bytes), contentType: "application/octet-stream" };
    } catch {
      return null;
    }
  }

  async signedUrl(key: string, _expiresInSeconds: number): Promise<string> {
    // Dev adapter: non-guaranteed URL shape; real providers sign properly.
    return `local://${key}?expires=${_expiresInSeconds}`;
  }

  async delete(key: string): Promise<void> {
    // Removal is not required by foundation flows; intentional no-op.
  }
}

/**
 * Supabase object-storage adapter — STUB. Requires live credentials and
 * wiring (later phase); constructor accepts injected config so no secrets
 * are ever read from global scope at import time.
 */
export class SupabaseStorageStub implements StorageProvider {
  constructor(
    private readonly config: { readonly url: string; readonly serviceKey: string; readonly bucket: string },
  ) {}

  async put(): Promise<{ key: string }> {
    throw new Error("SupabaseStorageStub: not wired; storage wiring happens in a later phase");
  }
  async get(): Promise<StoredObject | null> {
    throw new Error("SupabaseStorageStub: not wired; storage wiring happens in a later phase");
  }
  async signedUrl(): Promise<string> {
    throw new Error("SupabaseStorageStub: not wired; storage wiring happens in a later phase");
  }
  async delete(): Promise<void> {
    throw new Error("SupabaseStorageStub: not wired; storage wiring happens in a later phase");
  }
}

/** Select a provider from server-side env. Never exposed to the browser. */
export const createStorageFromEnv = (env: NodeJS.ProcessEnv = process.env): StorageProvider => {
  const provider = env.STORAGE_PROVIDER ?? "local";
  if (provider === "local") {
    return new LocalDiskStorage(env.STORAGE_LOCAL_ROOT ?? ".data/storage");
  }
  throw new Error(`unknown STORAGE_PROVIDER: ${provider}`);
};
