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
import {
  createQcRepository,
  createQcService,
  type QcService,
} from "@stratifit/quality-control";
import {
  createDrizzlePublishingRepository,
  createPublishingService,
  DurableStratifitMediaAdapter,
  type PublishingService,
} from "@stratifit/publishing-engine";
import { createDatabase } from "@stratifit/database";
import { and, eq, inArray } from "drizzle-orm";
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
  qualityControl: QcService;
  publishing: PublishingService;
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
      // Stage 2.11: the QC service shares the SAME Drizzle pool and the SAME
      // audit transaction writer (D2.4-1 reused): a QC mutation and its audit
      // record commit in the SAME transaction. Subject resolution (D2.11-2)
      // uses narrow READ-ONLY org-conditioned lookups over the sanctioned
      // upstream families (asset_versions, generations, productions — DM
      // section 10: QC upstream = Asset, Generation, Production);
      // publication subjects FAIL CLOSED (durable Publishing does not
      // exist). QC never mutates any upstream aggregate — the hard
      // domain-separation rule (QC does not own asset approval state).
      qualityControl: createQcService({
        repository: createQcRepository({
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
        resolveSubject: async (orgId, subjectKind, subjectRef) => {
          const { assetVersions, generations, productions } = await import("@stratifit/database");
          if (subjectKind === "publication") {
            return { kind: "publication", unsupported: true } as const;
          }
          if (subjectKind === "asset_version") {
            const [row] = await db
              .select()
              .from(assetVersions)
              .where(and(eq(assetVersions.id, subjectRef), eq(assetVersions.orgId, orgId)))
              .limit(1);
            return row
              ? {
                  kind: "asset_version" as const,
                  assetVersion: {
                    id: row.id,
                    orgId: row.orgId,
                    assetId: row.assetId,
                    versionNumber: row.versionNumber,
                    bucket: row.bucket,
                    storageKey: row.storageKey,
                    checksum: row.checksum,
                    byteSize: row.byteSize,
                    mimeType: row.mimeType,
                    technicalMetadata: row.technicalMetadata,
                  },
                }
              : null;
          }
          if (subjectKind === "generation") {
            const [row] = await db
              .select({ id: generations.id, orgId: generations.orgId, status: generations.status })
              .from(generations)
              .where(and(eq(generations.id, subjectRef), eq(generations.orgId, orgId)))
              .limit(1);
            return row ? { kind: "generation" as const, generation: row } : null;
          }
          const [row] = await db
            .select({ id: productions.id, orgId: productions.orgId, status: productions.status })
            .from(productions)
            .where(and(eq(productions.id, subjectRef), eq(productions.orgId, orgId)))
            .limit(1);
          return row ? { kind: "production" as const, production: row } : null;
        },
      }),
      // Stage 2.12: the durable Publishing service shares the SAME Drizzle
      // pool and the SAME audit transaction writer (D2.4-1 reused). Subject
      // resolution (D2.12-D) uses narrow READ-ONLY org-conditioned lookups
      // over productions/asset_versions; ai_creator_profile/
      // campaign_creative FAIL CLOSED. The QC handoff (plan section 9)
      // delegates to qualityControl's eligibility evaluation — publishing
      // consumes the verdict only (zero QC→Asset coupling preserved). The
      // rights seam (D2.12-A) is UNWIRED — no Rights implementation or
      // stub exists in Stage 2.12; the service treats an absent port as a
      // vacuous pass. A future Rights stage injects the adapter here.
      publishing: createPublishingService({
        repository: createDrizzlePublishingRepository({
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
        resolveSubject: async (orgId, subjectKind, subjectRef) => {
          const { assetVersions, productions } = await import("@stratifit/database");
          if (subjectKind === "ai_creator_profile" || subjectKind === "campaign_creative") {
            return { kind: subjectKind, unsupported: true } as const;
          }
          if (subjectKind === "asset_version") {
            const [row] = await db
              .select({ id: assetVersions.id, orgId: assetVersions.orgId })
              .from(assetVersions)
              .where(and(eq(assetVersions.id, subjectRef), eq(assetVersions.orgId, orgId)))
              .limit(1);
            return row ? { kind: "asset_version" as const, orgId: row.orgId } : null;
          }
          const [row] = await db
            .select({ id: productions.id, orgId: productions.orgId })
            .from(productions)
            .where(and(eq(productions.id, subjectRef), eq(productions.orgId, orgId)))
            .limit(1);
          return row ? { kind: "production" as const, orgId: row.orgId } : null;
        },
        resolveEligibility: async (orgId, subjectKind, subjectRef) => {
          // QC handoff: evaluate the subject's durable QC state with the
          // established PURE evaluatePublicationEligibility (plan section 9).
          // No review → null → the publishing service fails closed.
          const { evaluatePublicationEligibility } = await import("@stratifit/quality-control");
          const { qcChecks, qcReviews, qcResults, qcIssues } = await import("@stratifit/database");
          const [review] = await db
            .select()
            .from(qcReviews)
            .where(
              and(
                eq(qcReviews.orgId, orgId),
                eq(qcReviews.subjectKind, subjectKind as "production" | "asset_version"),
                eq(qcReviews.subjectRef, subjectRef),
              ),
            )
            .limit(1);
          if (!review) return null;
          const results = await db.select().from(qcResults).where(eq(qcResults.reviewId, review.id));
          // Issues hang off RESULTS, not the review — collect them per result.
          const issuesByResult = results.length
            ? await db
                .select()
                .from(qcIssues)
                .where(inArray(qcIssues.resultId, results.map((r) => r.id)))
            : [];
          const checks = await db.select().from(qcChecks).where(eq(qcChecks.orgId, orgId));
          const verdict = evaluatePublicationEligibility(
            {
              status: review.status as "pending" | "in_review" | "approved" | "rejected" | "changes_requested",
              subjectKind: review.subjectKind as "production" | "asset_version",
            },
            results.map((r) => ({
              id: r.id,
              orgId: r.orgId,
              reviewId: r.reviewId,
              checkId: r.checkId,
              outcome: r.outcome as "pass" | "fail" | "warn" | "skipped",
              evaluatedBy: r.evaluatedBy as "human" | "automated",
              ruleRef: r.ruleRef,
              details: r.details,
              evaluatedAt: r.evaluatedAt.toISOString(),
            })),
            issuesByResult.map((i) => ({
              id: i.id,
              orgId: i.orgId,
              resultId: i.resultId,
              severity: i.severity as "blocker" | "major" | "minor" | "note",
              description: i.description,
              resolution: i.resolution as "open" | "resolved" | "waived",
              resolvedBy: i.resolvedBy,
              resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
              createdAt: i.createdAt.toISOString(),
              updatedAt: i.updatedAt.toISOString(),
            })),
            checks.map((c) => ({
              id: c.id,
              required: c.required,
              status: c.status as "active" | "archived",
              appliesToKind: c.appliesToKind as "production" | "asset_version",
            })),
          );
          return { ...verdict, reviewId: review.id };
        },
        adapters: [new DurableStratifitMediaAdapter()],
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

/** Exposed for the Stage 2.11 /api/control/qc routes (D2.11-5). */
export const getQcService = (): QcService => buildServices().qualityControl;

export const getPublishingService = (): PublishingService => buildServices().publishing;

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
