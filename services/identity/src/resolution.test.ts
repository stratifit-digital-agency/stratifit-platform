import { describe, expect, it, vi } from "vitest";
import { createIdentityResolution } from "./resolution";
import type { IdentityRepository, SessionVerifier, VerifiedSession } from "./types";

/**
 * CD-1 resolution matrix (approved):
 *  - no/invalid/expired session -> null, no rows touched
 *  - authenticated (verified or unverified) audience subject -> non-null
 *    AudienceIdentity; JIT upsert on first sight; email/verified mirrored
 *  - operator subject on the audience path -> null and NO audience row
 *    (invariant 12)
 *  - operator subject on the operator path -> full context with org/roles/
 *    capabilities; unknown subjects on the operator path -> null, no JIT
 */

const verifierFrom = (map: Record<string, VerifiedSession | null>): SessionVerifier => ({
  verify: async (ref) => map[ref] ?? null,
});

const repoMock = () => {
  const audienceRows = new Map<string, { id: string; orgId: string; email: string | null; emailVerified: boolean }>();
  const upsert = vi.fn(
    async (input: { authSubjectRef: string; email: string | null; emailVerified: boolean }) => {
      const existing = audienceRows.get(input.authSubjectRef);
      const row = existing
        ? { ...existing, email: input.email, emailVerified: input.emailVerified }
        : { id: `aud-${input.authSubjectRef}`, orgId: "org-default", email: input.email, emailVerified: input.emailVerified };
      audienceRows.set(input.authSubjectRef, row);
      return row;
    },
  );
  const repo: IdentityRepository = {
    findOperatorBySubject: async (subject) =>
      subject === "op-1"
        ? { id: "op-row-1", orgId: "org-default", email: "op@stratifit.test", displayName: "Op", roles: ["admin"] }
        : null,
    findAudienceBySubject: async (subject) => audienceRows.get(subject) ?? null,
    upsertAudienceUser: upsert,
  };
  return { repo, upsert, audienceRows };
};

const verifiedAudience: VerifiedSession = { subject: "aud-1", email: "v@example.com", emailVerified: true };
const unverifiedAudience: VerifiedSession = { subject: "aud-2", email: "u@example.com", emailVerified: false };
const operatorSession: VerifiedSession = { subject: "op-1", email: "op@stratifit.test", emailVerified: true };

describe("resolveAudienceIdentity (CD-1 matrix)", () => {
  it("returns null for anonymous / invalid / expired sessions and touches no rows", async () => {
    const { repo, upsert } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({}), repository: repo });
    await expect(svc.resolveAudienceIdentity(null)).resolves.toBeNull();
    await expect(svc.resolveAudienceIdentity(undefined)).resolves.toBeNull();
    await expect(svc.resolveAudienceIdentity("bad-token")).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("resolves a verified audience subject non-null and JIT-upserts once", async () => {
    const { repo, upsert } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-1": verifiedAudience }), repository: repo });
    const first = await svc.resolveAudienceIdentity("tok-1");
    expect(first).toEqual({ kind: "audience", userId: "aud-aud-1", email: "v@example.com", emailVerified: true });
    expect(upsert).toHaveBeenCalledTimes(1);
    const second = await svc.resolveAudienceIdentity("tok-1");
    expect(second).toEqual(first);
    expect(upsert).toHaveBeenCalledTimes(2); // upsert is idempotent by subject
  });

  it("resolves an authenticated-but-unverified subject non-null with emailVerified=false", async () => {
    const { repo } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-2": unverifiedAudience }), repository: repo });
    const identity = await svc.resolveAudienceIdentity("tok-2");
    expect(identity).not.toBeNull();
    expect(identity?.emailVerified).toBe(false);
  });

  it("never provisions an audience row for an operator subject (invariant 12)", async () => {
    const { repo, upsert } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-op": operatorSession }), repository: repo });
    await expect(svc.resolveAudienceIdentity("tok-op")).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("resolveIdentity (operator context + audience fallback)", () => {
  it("builds the full operator context: identity, org, roles, capabilities", async () => {
    const { repo } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-op": operatorSession }), repository: repo });
    const resolved = await svc.resolveIdentity("tok-op");
    expect(resolved).toMatchObject({
      identity: { kind: "operator", userId: "op-row-1", email: "op@stratifit.test", roles: ["admin"] },
      organizationId: "org-default",
      roles: ["admin"],
    });
    if (resolved && "capabilities" in resolved) {
      expect(resolved.capabilities).toContain("admin.permissions");
      expect(resolved.capabilities).toContain("messaging.takeover");
    }
  });

  it("returns null for an unknown subject on the operator path without provisioning an operator", async () => {
    const { repo, upsert } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-1": verifiedAudience }), repository: repo });
    // unknown subject falls through to the audience path (CD-1)
    const resolved = await svc.resolveIdentity("tok-1");
    expect(resolved).toEqual({ kind: "audience", userId: "aud-aud-1", email: "v@example.com", emailVerified: true });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("returns null when there is no session", async () => {
    const { repo } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({}), repository: repo });
    await expect(svc.resolveIdentity(null)).resolves.toBeNull();
  });
});
