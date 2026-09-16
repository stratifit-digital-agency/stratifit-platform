import { describe, expect, it } from "vitest";
import { capabilitiesFor, hasCapability } from "./capabilities";

describe("operator capability matrix", () => {
  it("gives admins everything", () => {
    expect(capabilitiesFor(["admin"])).toContain("admin.permissions");
  });

  it("lets reviewers approve but not allocate compute", () => {
    expect(hasCapability(["reviewer"], "production.approve")).toBe(true);
    expect(hasCapability(["reviewer"], "compute.allocate")).toBe(false);
  });

  it("prevents viewers from planning", () => {
    expect(hasCapability(["viewer"], "production.plan")).toBe(false);
  });

  it("unions multiple roles without duplicates", () => {
    const caps = capabilitiesFor(["reviewer", "operator"]);
    expect(new Set(caps).size).toBe(caps.length);
    expect(caps).toContain("lead.assign");
  });
});
