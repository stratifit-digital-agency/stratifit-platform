import { capabilitiesFor, type ControlCapability } from "@stratifit/permissions";
import type { OperatorRole } from "@stratifit/auth";
import {
  createDrizzleIdentityRepository,
  createDrizzleMembershipRepository,
  createIdentityResolution,
  createMembershipService,
  createSupabaseSessionVerifier,
  type MembershipService,
  type OperatorIdentityContext,
} from "@stratifit/identity";
import {
  createAdminAuditService,
  createDrizzleAuditRepository,
  type AdminAuditService,
} from "@stratifit/admin-audit";
import {
  createDrizzleProductionRepository,
  createProductionService,
  type ProductionService,
} from "@stratifit/production-engine";
import { createDatabase } from "@stratifit/database";
import { createControlCookieClient, controlAuthEnv } from "@/lib/supabase-server";

/**
 * Control composition root (D3) + Stage 2.4 admin/audit wiring.
 *
 * Server-side only: the operator session is read from the managed cookies,
 * verified by services/identity (Supabase Auth), and resolved against the
 * durable identity state. Pages/routes receive an explicit operator context
 * and enforce capabilities with the existing matrix — never client claims.
 *
 * Stage 2.4 (D2.4-1 Option A): one shared Drizzle pool feeds both the
 * membership repository and the admin-audit repository, and the admin-audit
 * transaction writer is injected into the membership repository so a
 * security-critical mutation and its audit record commit in the SAME
 * transaction (no second connection, no second transaction).
 */

export interface ControlOperatorContext extends OperatorIdentityContext {
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
}

let services: {
  membership: MembershipService;
  audit: AdminAuditService;
  production: ProductionService;
} | null = null;

const buildServices = () => {
  if (!services) {
    const db = createDatabase(process.env.DATABASE_URL as string);
    const audit = createAdminAuditService({ repository: createDrizzleAuditRepository({ db }) });
    const writer = audit.transactionWriter();
    const membershipRepo = createDrizzleMembershipRepository({
      db,
      // Composition-root adapter: identity's D4 seam shape (targetType/
      // targetId/metadata) maps to admin-audit's canonical entry shape
      // (subjectKind/subjectId/payload). The writer runs on the transaction
      // connection handed to it — same-transaction per D2.4-1.
      auditWriter: {
        appendWithin: (tx, entry) =>
          writer.appendWithin(tx, {
            actorId: entry.actorId,
            action: entry.action,
            subjectKind: entry.targetType,
            subjectId: entry.targetId,
            organizationId: entry.organizationId ?? null,
            correlationId: entry.correlationId ?? null,
            causationId: entry.causationId ?? null,
            payload: entry.metadata ?? {},
          }),
      },
    });
    // Stage 2.6: the production service shares the SAME Drizzle pool and the
    // SAME audit transaction writer, so a security-critical production
    // mutation (gate decision, approval, manifest issuance) and its audit
    // record commit in the SAME transaction (D2.4-1 reused, not duplicated).
    const production = createProductionService({
      repository: createDrizzleProductionRepository({
        db,
        // Composition-root adapter: the production engine's seam shape
        // (targetType/targetId/metadata) maps to admin-audit's canonical
        // entry shape (subjectKind/subjectId/payload) — the same mapping the
        // membership path uses. The writer runs on the transaction connection
        // handed to it — same-transaction per D2.4-1.
        auditWriter: {
          appendWithin: (tx, entry) =>
            writer.appendWithin(tx, {
              actorId: entry.actorId,
              action: entry.action,
              subjectKind: entry.targetType,
              subjectId: entry.targetId,
              organizationId: entry.organizationId ?? null,
              correlationId: entry.correlationId ?? null,
              causationId: entry.causationId ?? null,
              payload: entry.metadata ?? {},
            }),
        },
      }),
    });
    services = {
      audit: audit,
      production,
      membership: createMembershipService({
        repository: membershipRepo,
        // D2.4-1: transaction path is primary; this fallback seam is unused
        // with the Drizzle repository but kept for repositories without
        // transaction support. It uses the SAME seam->entry mapping as the
        // transaction writer so both paths emit canonical audit entries.
        auditAppend: (entry) =>
          audit.append({
            actorId: entry.actorId,
            action: entry.action,
            subjectKind: entry.targetType,
            subjectId: entry.targetId,
            organizationId: entry.organizationId ?? null,
            correlationId: entry.correlationId ?? null,
            causationId: entry.causationId ?? null,
            payload: entry.metadata ?? {},
          }),
      }),
    };
  }
  return services;
};

/** Exposed for route handlers needing the full membership service surface. */
export const getMembershipService = (): MembershipService => buildServices().membership;

/** Exposed for the audit trail query route (D2.4-2 org-scoped reads). */
export const getAuditService = (): AdminAuditService => buildServices().audit;

/** Exposed for the Stage 2.6 /api/control/{projects,productions} routes. */
export const getProductionService = (): ProductionService => buildServices().production;

/** Resolve the current operator server-side; null when anonymous/unprovisioned. */
export const resolveControlOperator = async (): Promise<ControlOperatorContext | null> => {
  if (!controlAuthEnv().supabaseUrl || !process.env.DATABASE_URL) return null;
  const supabase = createControlCookieClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  const resolved = await createIdentityResolution({
    sessionVerifier: createSupabaseSessionVerifier({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    }),
    repository: createDrizzleIdentityRepository({ databaseUrl: process.env.DATABASE_URL as string }),
  }).resolveIdentity(session.access_token);
  if (!resolved || !("capabilities" in resolved)) return null;
  return resolved as ControlOperatorContext;
};

export { capabilitiesFor };
