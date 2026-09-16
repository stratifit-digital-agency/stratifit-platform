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
  ],
  reviewer: ["production.approve", "audit.read"],
  viewer: ["audit.read"],
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
