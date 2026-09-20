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

  // Stage 2.16 (D2.16-4): dedicated people.* family — People authoring is
  // never reused production.publish, and read is separated from manage.
  describe("people.* capability family (Stage 2.16, D2.16-4)", () => {
    it("grants people.manage to admin and operator, never to reviewer/viewer", () => {
      expect(hasCapability(["admin"], "people.manage")).toBe(true);
      expect(hasCapability(["operator"], "people.manage")).toBe(true);
      expect(hasCapability(["reviewer"], "people.manage")).toBe(false);
      expect(hasCapability(["viewer"], "people.manage")).toBe(false);
    });

    it("grants people.read to every Control role", () => {
      for (const role of ["admin", "operator", "reviewer", "viewer"] as const) {
        expect(hasCapability([role], "people.read")).toBe(true);
      }
    });

    it("never derives people.* from production.publish", () => {
      // An operator can publish productions AND author People, but the two
      // capabilities are independently revocable — no derivation.
      expect(hasCapability(["operator"], "production.publish")).toBe(true);
      expect(hasCapability(["operator"], "people.manage")).toBe(true);
      expect(hasCapability(["reviewer"], "people.manage")).toBe(false);
    });
  });
});
