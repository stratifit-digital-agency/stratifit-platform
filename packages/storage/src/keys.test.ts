import { describe, expect, it } from "vitest";
import {
  STORAGE_KEY_KINDS,
  StorageKeyError,
  buildStorageKey,
  isUuid,
  isUuidV4,
  parseStorageKey,
} from "./keys";

/**
 * Stage 2.5 key-policy suite (decision D2.5-2): canonical shape, tenant
 * namespacing, the exact three-kind allowlist, UUID validation, and structural
 * rejection of traversal/absolute/backslash/empty-segment manipulation.
 */
const ORG = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const ID = "11111111-2222-4333-8444-555555555555";

describe("buildStorageKey", () => {
  it("produces the canonical org/{orgId}/{kind}/{uuid} shape for every allowed kind", () => {
    for (const kind of STORAGE_KEY_KINDS) {
      expect(buildStorageKey({ organizationId: ORG, kind, id: ID })).toBe(
        `org/${ORG}/${kind}/${ID}`,
      );
    }
  });

  it("is deterministic", () => {
    const a = buildStorageKey({ organizationId: ORG, kind: "assets", id: ID });
    const b = buildStorageKey({ organizationId: ORG, kind: "assets", id: ID });
    expect(a).toBe(b);
  });

  it("rejects a missing orgId, kind, or id", () => {
    expect(() => buildStorageKey({ organizationId: "", kind: "assets", id: ID })).toThrow(
      StorageKeyError,
    );
    expect(() =>
      buildStorageKey({ organizationId: ORG, kind: undefined as never, id: ID }),
    ).toThrow(StorageKeyError);
    expect(() => buildStorageKey({ organizationId: ORG, kind: "assets", id: "" })).toThrow(
      StorageKeyError,
    );
  });

  it("rejects unexpected kind values (no future taxonomy, no domain AssetKind)", () => {
    for (const bad of ["video", "audio", "image", "master", "thumbnail", "Assets", "GENERATIONS", ""]) {
      expect(() => buildStorageKey({ organizationId: ORG, kind: bad as never, id: ID })).toThrow(
        StorageKeyError,
      );
    }
  });

  it("rejects malformed org and object UUIDs", () => {
    expect(() =>
      buildStorageKey({ organizationId: "not-a-uuid", kind: "assets", id: ID }),
    ).toThrow(StorageKeyError);
    expect(() =>
      buildStorageKey({ organizationId: ORG, kind: "assets", id: "nope" }),
    ).toThrow(StorageKeyError);
    expect(() =>
      buildStorageKey({ organizationId: ORG, kind: "assets", id: "11111111-2222-4333-7444-555555555555" }),
    ).toThrow(StorageKeyError); // wrong variant nibble -> not v4
  });
});

describe("isUuid / isUuidV4", () => {
  it("validates UUID shapes", () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid("11111111-2222-3333-8444-555555555555")).toBe(true);
    expect(isUuidV4(ID)).toBe(true);
    expect(isUuidV4("11111111-2222-3333-8444-555555555555")).toBe(false);
    expect(isUuid("zzzz")).toBe(false);
  });
});

describe("parseStorageKey", () => {
  it("round-trips canonical keys deterministically", () => {
    for (const kind of STORAGE_KEY_KINDS) {
      const key = buildStorageKey({ organizationId: ORG, kind, id: ID });
      expect(parseStorageKey(key)).toEqual({ organizationId: ORG, kind, id: ID });
    }
  });

  it("rejects traversal, dot segments, absolute paths, and backslashes", () => {
    const valid = `org/${ORG}/assets/${ID}`;
    expect(() => parseStorageKey(`org/${ORG}/../${ID}`)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(`org/../${ORG}/assets/${ID}`)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(`org/${ORG}/./${ID}`)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(`/org/${ORG}/assets/${ID}`)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(`org\\${ORG}\\assets\\${ID}`)).toThrow(StorageKeyError);
    // double-slash empty segments
    expect(() => parseStorageKey(`org//${ORG}/assets/${ID}`)).toThrow(StorageKeyError);
    // never accept a mutated valid key
    expect(parseStorageKey(valid)).not.toBeNull();
  });

  it("rejects wrong segment counts and wrong namespace", () => {
    expect(() => parseStorageKey(`org/${ORG}/assets`)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(`org/${ORG}/assets/${ID}/extra`)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(`tenant/${ORG}/assets/${ID}`)).toThrow(StorageKeyError);
  });

  it("rejects unknown kinds and malformed identifiers on re-validation", () => {
    expect(() => parseStorageKey(`org/${ORG}/secrets/${ID}`)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(`org/not-a-uuid/assets/${ID}`)).toThrow(StorageKeyError);
    expect(() => parseStorageKey(`org/${ORG}/assets/not-a-uuid`)).toThrow(StorageKeyError);
  });
});
