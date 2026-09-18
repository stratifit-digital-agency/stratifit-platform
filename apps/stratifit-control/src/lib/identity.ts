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
  createCatalogRepository,
  createCatalogService,
  type CatalogService,
} from "@stratifit/ai";
import {
  createWorkflowCatalogRepository,
  createWorkflowCatalogService,
  type WorkflowCatalogService,
} from "@stratifit/workflows";
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
import {
  createGenerationRepository,
  createGenerationService,
  type GenerationService,
} from "@stratifit/generation";
import {
  createAssetRepository,
  createAssetService,
  type AssetService,
} from "@stratifit/assets";
import { createDatabase } from "@stratifit/database";
import { and, eq } from "drizzle-orm";
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
  catalog: CatalogService;
  workflowCatalog: WorkflowCatalogService;
  generation: GenerationService;
  assets: AssetService;
} | null = null;

const buildServices = () => {
  if (!services) {
    const db = createDatabase(process.env.DATABASE_URL as string);
    const audit = createAdminAuditService({ repository: createDrizzleAuditRepository({ db }) });
    const writer = audit.transactionWriter();
    // Stage 2.9: narrow Catalog resolution ports over the SAME pool — the
    // generation service reads (never writes) the Stage 2.8 catalog families
    // through these structural seams (SVC sanctioned import: generation ──► ai,
    // workflows; read-only, org-conditioned selects).
    const registry = {
      catalog: {
        findModel: async (orgId: string, modelId: string) => {
          const { models } = await import("@stratifit/database");
          const [row] = await db
            .select({ id: models.id, orgId: models.orgId, name: models.name, status: models.status })
            .from(models)
            .where(and(eq(models.id, modelId), eq(models.orgId, orgId)))
            .limit(1);
          return row ?? null;
        },
        resolveModelVersion: async (orgId: string, modelId: string, version: string) => {
          const { modelVersions } = await import("@stratifit/database");
          const [row] = await db
            .select({
              id: modelVersions.id,
              orgId: modelVersions.orgId,
              modelId: modelVersions.modelId,
              version: modelVersions.version,
              status: modelVersions.status,
            })
            .from(modelVersions)
            .where(and(eq(modelVersions.orgId, orgId), eq(modelVersions.modelId, modelId), eq(modelVersions.version, version)))
            .limit(1);
          return row ? { ...row, status: row.status as "active" | "deprecated" | "disabled" } : null;
        },
      },
      workflow: {
        findWorkflow: async (orgId: string, workflowId: string) => {
          const { workflows } = await import("@stratifit/database");
          const [row] = await db
            .select({ id: workflows.id, orgId: workflows.orgId, name: workflows.name, status: workflows.status })
            .from(workflows)
            .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
            .limit(1);
          return row ?? null;
        },
        resolveWorkflowVersion: async (orgId: string, workflowId: string, version: string) => {
          const { workflowVersions } = await import("@stratifit/database");
          const [row] = await db
            .select({
              id: workflowVersions.id,
              orgId: workflowVersions.orgId,
              workflowId: workflowVersions.workflowId,
              version: workflowVersions.version,
              status: workflowVersions.status,
            })
            .from(workflowVersions)
            .where(and(eq(workflowVersions.orgId, orgId), eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)))
            .limit(1);
          return row ? { ...row, status: row.status as "active" | "deprecated" | "disabled" } : null;
        },
      },
    };
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
      // Stage 2.8: the durable model/workflow registries share the SAME
      // Drizzle pool and the SAME audit transaction writer (D2.4-1 reused):
      // a registry mutation and its audit record commit in the SAME
      // transaction. Composition-root adapter maps the catalog seam shape
      // (targetType/targetId/metadata) to admin-audit's canonical entry
      // (subjectKind/subjectId/payload) — same mapping as above.
      catalog: createCatalogService({
        repository: createCatalogRepository({
          db,
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
      }),
      workflowCatalog: createWorkflowCatalogService({
        repository: createWorkflowCatalogRepository({
          db,
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
      }),
      // Stage 2.9: the generation service shares the SAME Drizzle pool and
      // the SAME audit transaction writer (D2.4-1 reused): an actor-
      // originated generation mutation (request/cancel) and its audit record
      // commit in the SAME transaction. Composition-root adapter maps the
      // generation seam shape (targetType/targetId/metadata) to admin-audit's
      // canonical entry (subjectKind/subjectId/payload) — same mapping as the
      // other services above.
      generation: createGenerationService({
        repository: createGenerationRepository({
          db,
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
        // D2.8-3: generation resolves manifest selections against the
        // durable Catalog (read-only ports over the SAME pool, above).
        modelRegistry: registry.catalog,
        workflowRegistry: registry.workflow,
      }),
      // Stage 2.10: the asset service shares the SAME Drizzle pool and the
      // SAME audit transaction writer (D2.4-1 reused): an operator-originated
      // asset mutation and its audit record commit in the SAME transaction.
      // Composition-root adapter maps the asset seam shape (targetType/
      // targetId/metadata) to admin-audit's canonical entry (subjectKind/
      // subjectId/payload) — same mapping as the other services above.
      assets: createAssetService({
        repository: createAssetRepository({
          db,
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
      }),
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

/** Exposed for the Stage 2.8 /api/control/models routes (D2.8-1). */
export const getCatalogService = (): CatalogService => buildServices().catalog;

/** Exposed for the Stage 2.8 /api/control/workflows routes (D2.8-1). */
export const getWorkflowCatalogService = (): WorkflowCatalogService => buildServices().workflowCatalog;

/** Exposed for the Stage 2.9 /api/control/generations routes (D2.9-3). */
export const getGenerationService = (): GenerationService => buildServices().generation;

/** Exposed for the Stage 2.10 /api/control/assets routes (D2.10-3). */
export const getAssetService = (): AssetService => buildServices().assets;

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
