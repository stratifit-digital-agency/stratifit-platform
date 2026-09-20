import type { OperatorRole } from "@stratifit/auth";

/**
 * Operator capability matrix — internal Control Room authorization.
 * Pure data + pure functions; enforcement happens server-side.
 *
 * Audience users have no capabilities here by design: they are audience, not
 * producers. Audience-side rules live in @stratifit/auth.
 */

export const ControlCapability = [
  "production.plan",
  "production.approve",
  "production.publish",
  "generation.request",
  "model.manage",
  "workflow.manage",
  "compute.allocate",
  "messaging.takeover",
  "lead.assign",
  "admin.permissions",
  "audit.read",
  // Stage 2.16 (People foundation, D2.16-4): dedicated people.* capability
  // family — People authoring is NOT reused production.publish. Two
  // domain-oriented capabilities:
  //   people.manage — Control-only authoring + lifecycle of the chain
  //     (digital humans, characters, personas, AI creators). Profile
  //     snapshots are NOT authorable here (D2.16-3: publication-authored).
  //   people.read   — organization-scoped read of People chain state.
  "people.manage",
  "people.read",
] as const;

export type ControlCapability = (typeof ControlCapability)[number];

const ROLE_CAPABILITIES: Record<OperatorRole, readonly ControlCapability[]> = {
  admin: ControlCapability,
  operator: [
    "production.plan",
    "production.approve",
    "production.publish",
    "generation.request",
    "workflow.manage",
    "compute.allocate",
    "messaging.takeover",
    "lead.assign",
    "audit.read",
    "people.manage",
    "people.read",
  ],
  reviewer: ["production.approve", "audit.read", "people.read"],
  viewer: ["audit.read", "people.read"],
};

export const capabilitiesFor = (roles: readonly OperatorRole[]): readonly ControlCapability[] => {
  const set = new Set<ControlCapability>();
  for (const role of roles) for (const cap of ROLE_CAPABILITIES[role]) set.add(cap);
  return [...set];
};

export const hasCapability = (
  roles: readonly OperatorRole[],
  capability: ControlCapability,
): boolean => capabilitiesFor(roles).includes(capability);
