import { describe, expect, it, vi } from "vitest";
import { authorizeOperator, createIdentityResolution } from "./resolution";
import type {
  IdentityRepository,
  OperatorAuthorizationLookup,
  SessionVerifier,
  VerifiedSession,
} from "./types";

/**
 * CD-1 resolution matrix (approved) + Stage 2.2 D-1/D-2 authorization:
 *  - no/invalid/expired session -> null, no rows touched
 *  - authenticated (verified or unverified) audience subject -> non-null
 *    AudienceIdentity; JIT upsert on first sight; email/verified mirrored
 *  - operator subject on the audience path -> null and NO audience row
 *    (invariant 12)
 *  - operator subject on the operator path -> context derives SOLELY from the
 *    active org membership (D-1); any missing/suspended element fails closed
 *    to null (D-2). No `operators.roles` fallback exists.
 */

const verifierFrom = (map: Record<string, VerifiedSession | null>): SessionVerifier => ({
  verify: async (ref) => map[ref] ?? null,
});

const activeLookup = (overrides: Partial<OperatorAuthorizationLookup> = {}): OperatorAuthorizationLookup => ({
  operatorStatus: "active",
  organizationId: "org-default",
  organizationStatus: "active",
  orgMembership: { id: "m-1", role: "admin", status: "active" },
  ...overrides,
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
    findOperatorBySubject: vi.fn(async (subject) =>
      subject === "op-1"
        ? { id: "op-row-1", email: "op@stratifit.test", displayName: "Op", status: "active" }
        : null,
    ),
    findOperatorAuthorization: vi.fn(async (operatorId) =>
      operatorId === "op-row-1" ? activeLookup() : null,
    ),
    findAudienceBySubject: vi.fn(async (subject) => audienceRows.get(subject) ?? null),
    upsertAudienceUser: upsert,
  };
  return { repo, upsert, audienceRows };
};

const verifiedAudience: VerifiedSession = { subject: "aud-1", email: "v@example.com", emailVerified: true };
const unverifiedAudience: VerifiedSession = { subject: "aud-2", email: "u@example.com", emailVerified: false };
const operatorSession: VerifiedSession = { subject: "op-1", email: "op@stratifit.test", emailVerified: true };

describe("authorizeOperator (pure fail-closed decision, D-2)", () => {
  it("allows an active operator with an active org and active membership", () => {
    expect(authorizeOperator(activeLookup())).toEqual({
      allowed: true,
      organizationId: "org-default",
      roles: ["admin"],
    });
  });

  it("denies each failing element (D-2 matrix)", () => {
    expect(authorizeOperator(activeLookup({ operatorStatus: "suspended" }))).toMatchObject({ allowed: false });
    expect(authorizeOperator(activeLookup({ organizationStatus: "suspended" }))).toMatchObject({ allowed: false });
    expect(authorizeOperator(activeLookup({ organizationStatus: "archived" }))).toMatchObject({ allowed: false });
    expect(authorizeOperator(activeLookup({ orgMembership: null }))).toMatchObject({ allowed: false });
    expect(
      authorizeOperator(activeLookup({ orgMembership: { id: "m-1", role: "viewer", status: "inactive" } })),
    ).toMatchObject({ allowed: false });
    expect(
      authorizeOperator(activeLookup({ orgMembership: { id: "m-1", role: "viewer", status: "suspended" } })),
    ).toMatchObject({ allowed: false });
    expect(
      authorizeOperator(activeLookup({ orgMembership: { id: "m-1", role: "viewer", status: "revoked" } })),
    ).toMatchObject({ allowed: false });
  });

  it("denies unknown statuses (fail closed, never open)", () => {
    expect(authorizeOperator(activeLookup({ operatorStatus: "weird" }))).toMatchObject({ allowed: false });
    expect(authorizeOperator(activeLookup({ organizationStatus: "weird" }))).toMatchObject({ allowed: false });
    expect(
      authorizeOperator(activeLookup({ orgMembership: { id: "m-1", role: "viewer", status: "weird" } })),
    ).toMatchObject({ allowed: false });
  });
});

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

  it("never provisions an audience row for an operator subject (invariant 12) — even an unauthorized one", async () => {
    const { repo, upsert } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-op": operatorSession }), repository: repo });
    await expect(svc.resolveAudienceIdentity("tok-op")).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("resolveIdentity (membership-derived authorization, D-1/D-2)", () => {
  it("builds the full operator context from the active org membership", async () => {
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

  it("FAILS CLOSED to null for every D-2 denial state (no capabilities leak)", async () => {
    const { repo } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-op": operatorSession }), repository: repo });
    const denials: (Partial<OperatorAuthorizationLookup> | null)[] = [
      { operatorStatus: "suspended" },
      { organizationStatus: "suspended" },
      { organizationStatus: "archived" },
      { orgMembership: null },
      { orgMembership: { id: "m-1", role: "admin", status: "inactive" } },
      { orgMembership: { id: "m-1", role: "admin", status: "suspended" } },
    ];
    for (const override of denials) {
      (repo.findOperatorAuthorization as ReturnType<typeof vi.fn>).mockImplementation(async () =>
        override === null ? null : activeLookup(override),
      );
      await expect(svc.resolveIdentity("tok-op")).resolves.toBeNull();
    }
    // missing authorization row entirely -> null
    (repo.findOperatorAuthorization as ReturnType<typeof vi.fn>).mockImplementation(async () => null);
    await expect(svc.resolveIdentity("tok-op")).resolves.toBeNull();
  });

  it("never derives authorization from operators.roles (D-1): no membership means no role, regardless of legacy metadata", async () => {
    const { repo } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-op": operatorSession }), repository: repo });
    // Simulate legacy metadata carrying roles while the membership is inactive:
    (repo.findOperatorAuthorization as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      activeLookup({ orgMembership: { id: "m-1", role: "viewer", status: "inactive" } }),
    );
    await expect(svc.resolveIdentity("tok-op")).resolves.toBeNull();
  });

  it("returns null for an unknown subject on the operator path (audience fallback, CD-1)", async () => {
    const { repo, upsert } = repoMock();
    const svc = createIdentityResolution({ sessionVerifier: verifierFrom({ "tok-1": verifiedAudience }), repository: repo });
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
