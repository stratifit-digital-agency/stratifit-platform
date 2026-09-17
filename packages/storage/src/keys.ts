/**
 * Tenant-namespaced object-key policy (Stage 2.5, decisions D2.5-2/D2.5-3).
 *
 * Canonical format:  org/{orgId}/{kind}/{uuid}
 *
 * Storage keys stay OPAQUE with respect to the domain taxonomy: DOMAIN_MODEL's
 * AssetKind/subtype values are database metadata owned by the Stage 2.6 assets
 * module, never key segments (DATA_FLOW §11 treats keys as opaque references).
 * The `kind` segment is a ROLE separator only. Exact allowlist per approved
 * decision D2.5-2 (additive extension requires a new approved decision):
 *
 *   assets       — operator-uploaded / input media (masters and their sources)
 *   generations  — AI generation outputs
 *   derivatives  — derived versions (thumbnails, posters, trailers, transcodes,
 *                  subtitles, renders)
 */

/** The exact approved kind allowlist. Never extended without approval. */
export const STORAGE_KEY_KINDS = ["assets", "generations", "derivatives"] as const;

export type StorageKeyKind = (typeof STORAGE_KEY_KINDS)[number];

export interface StorageKeyInput {
  readonly organizationId: string;
  readonly kind: StorageKeyKind;
  /** UUIDv4 object identifier (the object's future AssetVersion id). */
  readonly id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Structural validity of a UUID (any version/variant accepted for input). */
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => ANY_UUID_RE.test(value);

/** True when `id` is a canonical UUIDv4 (the only id shape keys are built from). */
export const isUuidV4 = (value: string): boolean => UUID_RE.test(value);

/**
 * Build the canonical tenant-namespaced key. Deterministic and pure.
 * Throws a classified StorageKeyError on any invalid input (fail-closed).
 */
export const buildStorageKey = (input: StorageKeyInput): string => {
  const { organizationId, kind, id } = input;

  if (typeof organizationId !== "string" || organizationId.length === 0) {
    throw new StorageKeyError("organizationId is required");
  }
  // orgId is itself a UUID in the platform schema; treat anything else as
  // invalid rather than allowing arbitrary path-bearing segments.
  if (!isUuid(organizationId)) {
    throw new StorageKeyError("organizationId must be a UUID");
  }
  if (!STORAGE_KEY_KINDS.includes(kind)) {
    throw new StorageKeyError(`kind must be one of: ${STORAGE_KEY_KINDS.join(", ")}`);
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new StorageKeyError("id is required");
  }
  if (!isUuidV4(id)) {
    throw new StorageKeyError("id must be a UUIDv4");
  }

  return `org/${organizationId}/${kind}/${id}`;
};

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageKeyError";
  }
}

export interface ParsedStorageKey {
  readonly organizationId: string;
  readonly kind: StorageKeyKind;
  readonly id: string;
}

/**
 * Parse and fully re-validate a storage key (round-trip safety). Accepts only
 * the exact canonical shape — no traversal, no absolute paths, no backslash
 * manipulation, no extra or missing segments, no ".'/'..' segments.
 */
export const parseStorageKey = (key: string): ParsedStorageKey => {
  if (typeof key !== "string" || key.length === 0) {
    throw new StorageKeyError("key must be a non-empty string");
  }
  if (key.includes("\\")) {
    throw new StorageKeyError("key must not contain backslashes");
  }
  if (key.startsWith("/")) {
    throw new StorageKeyError("key must not be an absolute path");
  }
  const segments = key.split("/");
  if (segments.length !== 4) {
    throw new StorageKeyError("key must have exactly 4 segments: org/{orgId}/{kind}/{id}");
  }
  if (segments[0] !== "org") {
    throw new StorageKeyError("key must start with the 'org' namespace");
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new StorageKeyError("key must not contain empty segments");
    }
    if (segment === "." || segment === "..") {
      throw new StorageKeyError("key must not contain '.' or '..' segments");
    }
  }
  const organizationId = segments[1]!;
  const kind = segments[2]!;
  const id = segments[3]!;
  if (!isUuid(organizationId)) {
    throw new StorageKeyError("organizationId segment must be a UUID");
  }
  const kindOk = (STORAGE_KEY_KINDS as readonly string[]).includes(kind);
  if (!kindOk) {
    throw new StorageKeyError(`kind segment must be one of: ${STORAGE_KEY_KINDS.join(", ")}`);
  }
  if (!isUuidV4(id)) {
    throw new StorageKeyError("id segment must be a UUIDv4");
  }
  return { organizationId, kind: kind as StorageKeyKind, id };
};
