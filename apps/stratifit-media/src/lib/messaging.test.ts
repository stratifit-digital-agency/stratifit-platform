import { describe, expect, it } from "vitest";
import { startConversation } from "./messaging";

const verified = { kind: "audience" as const, userId: "u1", email: "v@example.com", emailVerified: true };
const unverified = { ...verified, emailVerified: false };

describe("startConversation (server-side email verification gate)", () => {
  it("starts a conversation for a verified viewer with a valid message", () => {
    const result = startConversation(verified, { creatorHandle: "ava-ai", body: "I want a website like this." });
    expect(result.ok).toBe(true);
  });

  it("blocks unverified viewers with the email_verification_required reason", () => {
    const result = startConversation(unverified, { creatorHandle: "ava-ai", body: "hello" });
    expect(result).toEqual({ ok: false, reason: "email_verification_required" });
  });

  it("blocks anonymous viewers", () => {
    const result = startConversation(null, { creatorHandle: "ava-ai", body: "hello" });
    expect(result).toEqual({ ok: false, reason: "not_authenticated" });
  });

  it("rejects invalid handles or bodies for verified viewers", () => {
    expect(startConversation(verified, { creatorHandle: "Ava AI", body: "hi" }).ok).toBe(false);
    expect(startConversation(verified, { creatorHandle: "ava-ai", body: "" }).ok).toBe(false);
  });
});
