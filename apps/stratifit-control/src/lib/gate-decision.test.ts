import { describe, expect, it } from "vitest";
import { gateDecision } from "./gate-decision";

const configured = { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" };

describe("control gate decision (pure)", () => {
  it("redirects anonymous sessions to /login", () => {
    expect(gateDecision({ userId: null }, configured)).toEqual({ action: "redirect", location: "/login" });
  });

  it("admits authenticated sessions", () => {
    expect(gateDecision({ userId: "u-1" }, configured)).toEqual({ action: "next" });
  });

  it("fails closed when the issuer is not configured (OQ-3)", () => {
    expect(gateDecision({ userId: null }, { supabaseUrl: undefined, supabaseAnonKey: undefined })).toEqual({
      action: "fail-closed",
      status: 503,
    });
    expect(gateDecision({ userId: "u-1" }, { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: undefined })).toEqual({
      action: "fail-closed",
      status: 503,
    });
  });
});
