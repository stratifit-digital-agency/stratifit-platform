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
import { createAudienceService, createDrizzleAudienceRepository, slugify, type AudienceService } from "@stratifit/audience";import {
  createPeopleService,
  createDrizzlePeopleRepository,
  createCreatorSubjectPort,
  type PeopleService,
} from "@stratifit/people";
import {
  createMessagingService,
  createDrizzleMessagingRepository,
  createFixedWindowRateLimiter,
  type MessagingService,
} from "@stratifit/messaging";
import {
  createCreativeService,
  createDrizzleCreativeRepository,
  type CreativeService,
} from "@stratifit/creative";
import {
  createRightsService,
  createDrizzleRightsRepository,
  type RightsService,
} from "@stratifit/rights";
import { InProcessEventPublisher, idempotent } from "@stratifit/events";
import type { DomainEventEnvelope } from "@stratifit/contracts";
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
  audience: AudienceService;
  people: PeopleService;
  messaging: MessagingService;
  creative: CreativeService;
  rights: RightsService;
} | null = null;

const buildServices = () => {
  if (!services) {
    const db = createDatabase(process.env.DATABASE_URL as string);
    const audit = createAdminAuditService({ repository: createDrizzleAuditRepository({ db }) });
    const writer = audit.transactionWriter();
    // Stage 2.13 (D2.13 §6): exactly ONE shared in-process event bus. The
    // in-process transport cannot cross process boundaries, so the emitting
    // (publishing) and consuming (audience projection) sides must share this
    // instance in the Control composition. Envelopes arrive post-commit (the
    // publishing service emits only after its transaction commits); each
    // consumer runs in its own transaction. No outbox, no broker, no worker.
    // InProcessEventPublisher takes its handler list immutably, so the
    // audience handler is declared here (before the bus), closing over the
    // lazily built `services` slot; the bus is constructed with the handler
    // and the publishing service below emits onto THIS instance.
    const audienceHandler = idempotent(async (envelope: DomainEventEnvelope) => {
      const result =
        envelope.name === "publication.published"
          ? await services!.audience.projectPublished({ envelope })
          : envelope.name === "publication.unpublished"
            ? await services!.audience.unpublishContent({ envelope })
            : null;
      if (result && !result.ok) {
        console.error("[audience] consumer failed:", envelope.name, result.error.reason, result.error.message);
      }
    });
    // Stage 2.16 (D2.16-3): publication-mediated PEOPLE profile snapshots on
    // the SAME bus. The snapshot subject is derived SERVER-SIDE from the
    // durable publication record + the event envelope (never a client body):
    // the published payload carries publicationId/versionId; the durable
    // publication row supplies subject_kind/subject_ref (the AI creator id)
    // and the publishing-owned title/synopsis snapshot fields. Idempotent by
    // publication_version_id; a consumer failure does NOT roll back the
    // already-committed publication — it is observable here and repairable
    // through republishing (approved mediation semantics).
    const peopleHandler = idempotent(async (envelope: DomainEventEnvelope) => {
      if (envelope.name !== "publication.published" && envelope.name !== "publication.unpublished") {
        return;
      }
      const payload = envelope.payload as Record<string, unknown>;
      const publicationId = payload.publicationId;
      const orgId = envelope.correlation?.organizationId;
      if (typeof publicationId !== "string" || typeof orgId !== "string") return;
      try {
        if (envelope.name === "publication.published") {
          const versionId = payload.versionId;
          if (typeof versionId !== "string") return;
          // Resolve the durable publication row — the server-side subject source.
          const { publications, publicationVersions } = await import("@stratifit/database");
          const [pub] = await db
            .select()
            .from(publications)
            .where(eq(publications.id, publicationId))
            .limit(1);
          if (!pub || pub.subjectKind !== "ai_creator_profile") return; // not a people subject
          const [version] = await db
            .select()
            .from(publicationVersions)
            .where(eq(publicationVersions.id, versionId))
            .limit(1);
          if (!version) return;
          const result = await services!.people.upsertProfileSnapshot({
            orgId,
            aiCreatorId: pub.subjectRef, // server-derived — never client-supplied
            publicationId: pub.id,
            publicationVersionId: version.id,
            handle: version.title, // publishable snapshot fields from the immutable version
            displayName: version.title,
            bio: version.synopsis ?? null,
            personalitySnapshot: {},
            interestsSnapshot: [],
            avatarRef: null,
            posterRef: null,
            messagingEnabled: false,
          });
          if (!result.ok) {
            console.error("[people] snapshot failed:", result.error.reason, result.error.message);
          }
        } else {
          // publication.unpublished → retire the CURRENT snapshot. Resolve the
          // subject server-side from the durable publication row.
          const { publications } = await import("@stratifit/database");
          const [pub] = await db
            .select()
            .from(publications)
            .where(eq(publications.id, publicationId))
            .limit(1);
          if (!pub || pub.subjectKind !== "ai_creator_profile") return;
          const result = await services!.people.unpublishCurrentSnapshot({ orgId, aiCreatorId: pub.subjectRef });
          if (!result.ok) {
            console.error("[people] unpublish failed:", result.error.reason, result.error.message);
          }
        }
      } catch (e) {
        console.error("[people] consumer failed:", envelope.name, e);
      }
    });
    // Stage 2.18 (D2.18-SELECT/N1..N5): in-app NOTIFICATION projection on the
    // SAME bus. The handler consumes ONLY `message.created` (the payload
    // contract stays frozen) and resolves the recipient SERVER-SIDE from the
    // committed message + conversation rows (D2.18-N1 - the event payload
    // carries no recipient). Self-sends are suppressed; malformed/missing
    // source data never throws (typed outcomes); the audience service's
    // recordNotification is idempotent by envelope eventId (D2.18-P1) and
    // runs in its OWN transaction, so a consumer failure can never roll back
    // the already-committed message.
    const notificationsHandler = idempotent(async (envelope: DomainEventEnvelope) => {
      if (envelope.name !== "message.created") return;
      try {
        const payload = envelope.payload as Record<string, unknown>;
        const conversationId = payload.conversationId;
        const messageId = payload.messageId;
        if (typeof conversationId !== "string" || typeof messageId !== "string") {
          await services!.audience.recordNotification({
            kind: "invalid_event",
            message: "message.created payload missing conversationId/messageId",
          });
          return;
        }
        // D2.18-N1: recipient resolution reads COMMITTED state server-side.
        const { messages, conversations } = await import("@stratifit/database");
        const [message] = await db
          .select({
            id: messages.id,
            orgId: messages.orgId,
            conversationId: messages.conversationId,
            authorAudienceUserId: messages.authorAudienceUserId,
            body: messages.body,
          })
          .from(messages)
          .where(eq(messages.id, messageId))
          .limit(1);
        if (!message) {
          await services!.audience.recordNotification({ kind: "noop_missing" });
          return;
        }
        const [conversation] = await db
          .select({
            id: conversations.id,
            orgId: conversations.orgId,
            audienceUserId: conversations.audienceUserId,
          })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);
        if (!conversation) {
          await services!.audience.recordNotification({ kind: "noop_missing" });
          return;
        }
        // Source consistency: the committed message must belong to the
        // committed conversation (fail closed on any mismatch).
        if (message.conversationId !== conversation.id || message.orgId !== conversation.orgId) {
          await services!.audience.recordNotification({
            kind: "invalid_event",
            message: "message/conversation source mismatch",
          });
          return;
        }
        // Self-send suppression: the audience author never notifies itself.
        if (message.authorAudienceUserId === conversation.audienceUserId) {
          await services!.audience.recordNotification({ kind: "suppress_self_send" });
          return;
        }
        const result = await services!.audience.recordNotification({
          kind: "notify",
          notification: {
            orgId: conversation.orgId,
            audienceUserId: conversation.audienceUserId,
            kind: "conversation_reply",
            sourceKind: "conversation",
            sourceRef: conversation.id,
            eventId: envelope.eventId,
            title: "New reply",
            // Audience-appropriate preview of the recipient's OWN conversation
            // content - never operator identity, lead/assignment, or internal data.
            body: message.body.slice(0, 200),
          },
        });
        if (!result.ok) {
          console.error("[notifications] record failed:", result.error.reason, result.error.message);
        }
      } catch (e) {
        console.error("[notifications] consumer failed:", envelope.name, e);
      }
    });
    const eventBus = new InProcessEventPublisher([audienceHandler, peopleHandler, notificationsHandler]);
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
          // Stage 2.16 (D2.16-6): ai_creator_profile subjects are now DURABLY
          // resolvable — the creator must be ACTIVE and carry a live (status
          // = active) current profile in the SAME organization, through the
          // narrow read-only CreatorSubjectPort seam. Same-org + fail-closed
          // semantics preserved (cross-org/absent → null → subject_not_found).
          if (subjectKind === "ai_creator_profile") {
            const subject = await createCreatorSubjectPort({ db }).resolveActiveSubject(orgId, subjectRef);
            return subject ? { kind: "ai_creator_profile" as const, orgId: subject.orgId } : null;
          }
          if (subjectKind === "campaign_creative") {
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
        // Stage 2.13: publishing emits onto the SHARED bus (post-commit).
        publisher: eventBus,
      }),
      // Stage 2.13: the audience PUBLIC CONTENT projector consumes the
      // committed publishing facts on the SAME bus. projectPublished is
      // idempotent by publication_version_id (payload.versionId, verified
      // BUILD STEP 0); unpublishContent flips the projection only. The
      // consumer owns its transactions and the same-tx audit seam.
      audience: createAudienceService({
        repository: createDrizzleAudienceRepository({
          db,
          auditWriter: {
            appendWithin: (tx, entry) =>
              writer.appendWithin(tx as Parameters<typeof writer.appendWithin>[0], {
                actorId: entry.actorId,
                action: entry.action,
                subjectKind: entry.subjectKind,
                subjectId: entry.subjectId,
                organizationId: entry.organizationId ?? null,
                correlationId: entry.correlationId ?? null,
                causationId: entry.causationId ?? null,
                payload: entry.payload ?? {},
              }),
          },
        }),
        slugify,
      }),
      // Stage 2.16: the People service shares the SAME Drizzle pool and the
      // SAME audit transaction writer (D2.4-1 reused): a People mutation and
      // its audit record commit in the SAME transaction. The rights seam
      // (D2.16-2) is DECLARED but UNWIRED — absent port = vacuous pass. No
      // Rights tables/records/service exist.
      people: createPeopleService({
        repository: createDrizzlePeopleRepository({
          db,
          auditWriter: {
            appendWithin: (tx, entry) =>
              writer.appendWithin(tx as Parameters<typeof writer.appendWithin>[0], {
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
        // D2.16-2: NO rights port injected — production composition leaves
        // the seam unwired (vacuous pass). A future Rights stage adds the
        // adapter here.
      }),
      // Stage 2.17: the Messaging & Leads service shares the SAME Drizzle
      // pool and the SAME audit transaction writer (D2.4-1 reused): an
      // operator messaging/lead mutation and its audit record commit in the
      // SAME transaction. The D2.17-9 audience send limiter is the in-process
      // fixed-window default (a durable limiter later swaps behind the same
      // port). Conversation/lead events emit onto the SHARED bus post-commit;
      // no consumer is wired yet (Notifications is a future stage).
      messaging: createMessagingService({
        repository: createDrizzleMessagingRepository({
          db,
          auditWriter: {
            appendWithin: (tx, entry) =>
              writer.appendWithin(tx as Parameters<typeof writer.appendWithin>[0], {
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
        rateLimiter: createFixedWindowRateLimiter(),
        publisher: eventBus,
      }),
      // Stage 2.20: the Creative / Story service shares the SAME Drizzle pool
      // and the SAME audit transaction writer (D2.4-1 reused): a Creative
      // mutation and its audit record commit in the SAME transaction. There
      // is NO event publisher — Creative emits nothing (D2.20-4; taxonomy
      // stays 36). Control-only context (D2.20-7): no Media seam exists.
      creative: createCreativeService({
        repository: createDrizzleCreativeRepository({
          db,
          auditWriter: {
            appendWithin: (tx, entry) =>
              writer.appendWithin(tx as Parameters<typeof writer.appendWithin>[0], {
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
      // Stage 2.21: the Rights & Consent service shares the SAME Drizzle pool
      // and the SAME audit transaction writer (D2.4-1 reused): a Rights
      // mutation, its immutable status-event row, and its audit record commit
      // in the SAME transaction. NO event publisher — Rights emits nothing
      // (D2.21-3; taxonomy stays 36). Ports remain UNWIRED (D2.21-2): the
      // Publishing/People seams stay vacuous-pass until a future cutover.
      rights: createRightsService({
        repository: createDrizzleRightsRepository({
          db,
          auditWriter: {
            appendWithin: (tx, entry) =>
              writer.appendWithin(tx as Parameters<typeof writer.appendWithin>[0], {
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

/** Exposed for the Stage 2.11 /api/control/qc routes (D2.11-5). */
export const getQcService = (): QcService => buildServices().qualityControl;

export const getPublishingService = (): PublishingService => buildServices().publishing;

/** Exposed for the Stage 2.16 /api/control/people routes (D2.16-4). */
export const getPeopleService = (): PeopleService => buildServices().people;

/** Exposed for the Stage 2.17 /api/control/messaging routes (D2.17-6). */
export const getMessagingService = (): MessagingService => buildServices().messaging;

/** Exposed for the Stage 2.20 /api/control/creative routes (D2.20-5/D2.20-7). */
export const getCreativeService = (): CreativeService => buildServices().creative;

/** Exposed for the Stage 2.21 /api/control/rights routes (D2.21-4). */
export const getRightsService = (): RightsService => buildServices().rights;

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
