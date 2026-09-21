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

  // Stage 2.17 (D2.17-6): the frozen messaging capability mapping stands —
  // admin + operator work the inbox and the lead pipeline; reviewer/viewer
  // have no Messaging access (no new capabilities were created).
  describe("messaging capability family (Stage 2.17, D2.17-6)", () => {
    it("grants messaging.takeover to admin and operator only", () => {
      expect(hasCapability(["admin"], "messaging.takeover")).toBe(true);
      expect(hasCapability(["operator"], "messaging.takeover")).toBe(true);
      expect(hasCapability(["reviewer"], "messaging.takeover")).toBe(false);
      expect(hasCapability(["viewer"], "messaging.takeover")).toBe(false);
    });

    it("grants lead.assign to admin and operator only", () => {
      expect(hasCapability(["admin"], "lead.assign")).toBe(true);
      expect(hasCapability(["operator"], "lead.assign")).toBe(true);
      expect(hasCapability(["reviewer"], "lead.assign")).toBe(false);
      expect(hasCapability(["viewer"], "lead.assign")).toBe(false);
    });
  });

  it("unions multiple roles without duplicates", () => {
    const caps = capabilitiesFor(["reviewer", "operator"]);
    expect(new Set(caps).size).toBe(caps.length);
    expect(caps).toContain("lead.assign");
  });

  // Stage 2.20 (D2.20-5): dedicated creative.* family — narrative authoring
  // is never reused production.*; read is separated from manage.
  describe("creative.* capability family (Stage 2.20, D2.20-5)", () => {
    it("grants creative.manage to admin and operator only", () => {
      expect(hasCapability(["admin"], "creative.manage")).toBe(true);
      expect(hasCapability(["operator"], "creative.manage")).toBe(true);
      expect(hasCapability(["reviewer"], "creative.manage")).toBe(false);
      expect(hasCapability(["viewer"], "creative.manage")).toBe(false);
    });

    it("grants creative.read to every Control role", () => {
      for (const role of ["admin", "operator", "reviewer", "viewer"] as const) {
        expect(hasCapability([role], "creative.read")).toBe(true);
      }
    });

    it("never derives creative.* from production.*", () => {
      expect(hasCapability(["operator"], "production.publish")).toBe(true);
      expect(hasCapability(["operator"], "creative.manage")).toBe(true);
      expect(hasCapability(["reviewer"], "creative.manage")).toBe(false);
      expect(hasCapability(["viewer"], "creative.manage")).toBe(false);
    });
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
