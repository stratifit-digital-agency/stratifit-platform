import { describe, expect, it } from "vitest";
import { authorizeAudienceAction, verificationRequirementsFor } from "./identity";

const verified = { kind: "audience" as const, userId: "u1", email: "a@b.c", emailVerified: true };
const unverified = { ...verified, emailVerified: false };

describe("authorizeAudienceAction", () => {
  it("allows verified users to message", () => {
    expect(authorizeAudienceAction(verified, "message")).toEqual({ allowed: true });
  });

  it("blocks unverified users from message with a stable reason", () => {
    expect(authorizeAudienceAction(unverified, "message")).toEqual({
      allowed: false,
      reason: "email_verification_required",
    });
  });

  it("blocks anonymous users", () => {
    expect(authorizeAudienceAction(null, "comment")).toEqual({
      allowed: false,
      reason: "not_authenticated",
    });
  });

  it("allows like/follow without verification", () => {
    expect(authorizeAudienceAction(unverified, "like")).toEqual({ allowed: true });
    expect(authorizeAudienceAction(unverified, "follow")).toEqual({ allowed: true });
  });

  it("allows save without verification (audit Decision: save joins SocialCapabilityAction)", () => {
    expect(verificationRequirementsFor("save")).toEqual([]);
    expect(authorizeAudienceAction(unverified, "save")).toEqual({ allowed: true });
    expect(authorizeAudienceAction(verified, "save")).toEqual({ allowed: true });
  });
});
