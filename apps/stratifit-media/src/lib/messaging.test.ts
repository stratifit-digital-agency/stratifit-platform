import { describe, expect, it } from "vitest";
import { principalOf } from "./messaging";

const verified = { kind: "audience" as const, userId: "u1", email: "v@example.com", emailVerified: true };
const unverified = { ...verified, emailVerified: false };

describe("media messaging composition (Stage 2.17)", () => {
  it("builds the server-derived audience principal from the resolved identity", () => {
    const p = principalOf(verified);
    expect(p).toEqual({ kind: "audience", audienceUserId: "u1", emailVerified: true });
  });

  it("carries the server-side emailVerified mirror (never a client flag)", () => {
    expect(principalOf(unverified).emailVerified).toBe(false);
    expect(principalOf(verified).emailVerified).toBe(true);
  });
});
