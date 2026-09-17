/**
 * Supabase Storage adapter (Stage 2.5, decisions D2.5-1..D2.5-4).
 *
 * Implements the existing `StorageProvider` contract (`put/get/signedUrl/
 * delete`) against Supabase Storage. All configuration is constructor-injected
 * by the composition factory — this module never reads process.env, never
 * logs, and never exposes the service-role credential in errors.
 *
 * Bucket semantics (D2.5-2/D2.5-3): exactly one PRIVATE deployment-wide
 * bucket; the adapter never creates, alters, or publishes buckets and never
 * modifies bucket policies. Missing/unavailable bucket surfaces as a
 * classified StorageOperationError — never a silent fallback to local storage.
 *
 * Signed URLs (D2.5-3/D2.5-4): generated at read time only, expiry
 * parameterized with a 3600s default; invalid expiry fails closed; signed
 * URLs are returned to the caller and never logged here.
 */
import { createClient } from "@supabase/supabase-js";
import { StorageKeyError, parseStorageKey } from "./keys";
import type { StorageProvider, StoredObject } from "./provider";

/** Default signed-URL expiry per approved decision D2.5-4. */
export const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 3600;

/** Supabase's documented maximum signed-URL lifetime (7 days). */
const MAX_SIGNED_URL_EXPIRY_SECONDS = 604800;

export interface SupabaseStorageConfig {
  /** Supabase project URL (server-side; the public project URL is acceptable). */
  readonly url: string;
  /** Service-role credential. Server-only; injected, never logged or persisted. */
  readonly serviceKey: string;
  /** The single private deployment-wide bucket (env: SUPABASE_STORAGE_BUCKET). */
  readonly bucket: string;
}

/** Classified storage failure. Messages never contain credentials. */
export class StorageOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(`storage ${operation} failed: ${message}`);
    this.name = "StorageOperationError";
    this.operation = operation;
  }
}

/**
 * Minimal structural seam over @supabase/supabase-js storage — the exact
 * surface this adapter uses. The real SDK client satisfies it structurally;
 * tests inject a fake with the same shape, so no network or secrets are
 * needed in unit tests.
 */
export interface SupabaseStorageClient {
  from(bucket: string): {
    upload(path: string, body: Uint8Array, options: { contentType: string }): Promise<{ error: unknown }>;
    download(path: string): Promise<{ data: Blob | null; error: unknown }>;
    createSignedUrl(path: string, expiresInSeconds: number): Promise<{ data: { signedUrl?: string } | null; error: unknown }>;
    remove(paths: string[]): Promise<{ error: unknown }>;
  };
}

/** Fail-closed configuration guard shared by constructor and factory. */
export const assertStorageConfig = (config: SupabaseStorageConfig): void => {
  if (!config || typeof config.url !== "string" || config.url.trim().length === 0) {
    throw new StorageOperationError("configure", "configuration error: url is required");
  }
  if (!/^https?:\/\//i.test(config.url.trim())) {
    throw new StorageOperationError("configure", "configuration error: url must be an http(s) URL");
  }
  if (typeof config.serviceKey !== "string" || config.serviceKey.trim().length === 0) {
    throw new StorageOperationError("configure", "configuration error: serviceKey is required");
  }
  if (typeof config.bucket !== "string" || config.bucket.trim().length === 0) {
    throw new StorageOperationError("configure", "configuration error: bucket is required");
  }
};

export class SupabaseStorage implements StorageProvider {
  private readonly client: SupabaseStorageClient;

  constructor(
    private readonly config: SupabaseStorageConfig,
    clientFactory?: (config: SupabaseStorageConfig) => SupabaseStorageClient,
  ) {
    assertStorageConfig(config);
    this.client = clientFactory
      ? clientFactory(config)
      : (createClient(config.url, config.serviceKey).storage as unknown as SupabaseStorageClient);
  }

  private static describeError(error: unknown): string {
    // Keep only the provider's message text; never include request headers,
    // credentials, or full URLs that could carry access material.
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
      const maybe = error as { message?: unknown };
      if (typeof maybe.message === "string") return maybe.message;
    }
    return "unknown provider error";
  }

  private assertObjectKey(key: string, operation: string): void {
    try {
      parseStorageKey(key);
    } catch (error) {
      const message = error instanceof StorageKeyError ? error.message : "invalid key";
      throw new StorageOperationError(operation, message);
    }
  }

  private expiry(expiresInSeconds: number | undefined, operation = "signedUrl"): number {
    if (expiresInSeconds === undefined) return DEFAULT_SIGNED_URL_EXPIRY_SECONDS;
    if (!Number.isFinite(expiresInSeconds) || !Number.isInteger(expiresInSeconds)) {
      throw new StorageOperationError(operation, "expiry must be an integer number of seconds");
    }
    if (expiresInSeconds <= 0 || expiresInSeconds > MAX_SIGNED_URL_EXPIRY_SECONDS) {
      throw new StorageOperationError(
        operation,
        `expiry must be between 1 and ${MAX_SIGNED_URL_EXPIRY_SECONDS} seconds`,
      );
    }
    return expiresInSeconds;
  }

  async put(object: StoredObject): Promise<{ key: string }> {
    this.assertObjectKey(object.key, "put");
    try {
      const { error } = await this.client
        .from(this.config.bucket)
        .upload(object.key, object.bytes, { contentType: object.contentType });
      if (error) throw new Error(SupabaseStorage.describeError(error));
      return { key: object.key };
    } catch (error) {
      throw new StorageOperationError("put", SupabaseStorage.describeError(error));
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    this.assertObjectKey(key, "get");
    try {
      const { data, error } = await this.client.from(this.config.bucket).download(key);
      if (error) throw new Error(SupabaseStorage.describeError(error));
      if (!data) return null;
      const bytes = new Uint8Array(await data.arrayBuffer());
      return { key, bytes, contentType: data.type || "application/octet-stream" };
    } catch (error) {
      throw new StorageOperationError("get", SupabaseStorage.describeError(error));
    }
  }

  async signedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    this.assertObjectKey(key, "signedUrl");
    const expiry = this.expiry(expiresInSeconds);
    try {
      const { data, error } = await this.client
        .from(this.config.bucket)
        .createSignedUrl(key, expiry);
      if (error) throw new Error(SupabaseStorage.describeError(error));
      const url = data?.signedUrl;
      if (typeof url !== "string" || url.length === 0) {
        throw new Error("provider returned no signed URL");
      }
      // Returned to the caller only — never logged, never persisted.
      return url;
    } catch (error) {
      throw new StorageOperationError("signedUrl", SupabaseStorage.describeError(error));
    }
  }

  async delete(key: string): Promise<void> {
    this.assertObjectKey(key, "delete");
    try {
      const { error } = await this.client.from(this.config.bucket).remove([key]);
      if (error) throw new Error(SupabaseStorage.describeError(error));
    } catch (error) {
      throw new StorageOperationError("delete", SupabaseStorage.describeError(error));
    }
  }

  /**
   * Operational readiness check — concrete-adapter-only (NOT on the shared
   * StorageProvider interface, per the approved plan). Signing a URL for a
   * probe key exercises bucket authorization without mutating anything; a
   * missing/unavailable bucket fails classified.
   */
  async verifyBucketAccess(): Promise<void> {
    const probe = "org/00000000-0000-4000-8000-000000000000/assets/00000000-0000-4000-8000-000000000000";
    try {
      const { error } = await this.client
        .from(this.config.bucket)
        .createSignedUrl(probe, this.expiry(60, "verifyBucketAccess"));
      if (error) throw new Error(SupabaseStorage.describeError(error));
    } catch (error) {
      throw new StorageOperationError("verifyBucketAccess", SupabaseStorage.describeError(error));
    }
  }
}
