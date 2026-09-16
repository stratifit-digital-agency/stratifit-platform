import { describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: getUserMock } }),
}));

const { createSupabaseSessionVerifier } = await import("./supabase-session-verifier");

describe("createSupabaseSessionVerifier (adapter)", () => {
  it("verifies a bearer JWT and derives emailVerified from provider state", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: { id: "u-1", email: "v@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" } },
      error: null,
    });
    const verifier = createSupabaseSessionVerifier({ url: "https://x.supabase.co", anonKey: "anon" });
    await expect(verifier.verify("Bearer tok")).resolves.toEqual({
      subject: "u-1",
      email: "v@example.com",
      emailVerified: true,
    });
    expect(getUserMock).toHaveBeenCalledWith("tok");
  });

  it("treats unconfirmed email as unverified (server-derived, never a client claim)", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: { id: "u-2", email: "u@example.com", email_confirmed_at: null } },
      error: null,
    });
    const verifier = createSupabaseSessionVerifier({ url: "https://x.supabase.co", anonKey: "anon" });
    await expect(verifier.verify("tok")).resolves.toEqual({
      subject: "u-2",
      email: "u@example.com",
      emailVerified: false,
    });
  });

  it("maps verifier errors and empty refs to null sessions", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: { message: "bad jwt" } });
    const verifier = createSupabaseSessionVerifier({ url: "https://x.supabase.co", anonKey: "anon" });
    await expect(verifier.verify("junk")).resolves.toBeNull();
    await expect(verifier.verify("")).resolves.toBeNull();
    await expect(verifier.verify("   ")).resolves.toBeNull();
  });
});
