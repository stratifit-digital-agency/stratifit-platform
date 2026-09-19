/**
 * Publishing domain service (Stage 2.12, approved decisions D2.12-A..G).
 *
 * Operator-originated commands enforce, in order: capability
 * (`production.publish`, D2.12-G — no new permission) -> org boundary
 * (actor.organizationId is the SOLE org authority) -> subject ownership via
 * narrow read-only upstream ports (ai_creator_profile / campaign_creative
 * FAIL CLOSED, D2.12-D) -> deterministic validation -> state-machine
 * validity (DM section 32.6, with the approved correction: publish() is
 * valid ONLY from `scheduled`; the only path out of `approved` is
 * schedule()) -> persistence + same-transaction audit (D2.4-1) -> post-commit
 * event emission (in-process; a rolled-back transaction emits NOTHING).
 *
 * Approve fail-closed list (ALL required): QC gate eligible (review approved
 * + every required active applicable check's latest result pass + zero
 * unresolved blockers, via the PURE evaluatePublicationEligibility consumed
 * through the narrow port) + rights requirements met (D2.12-A vacuous pass
 * when nothing is declared) + subject same-org. Any uncertainty fails
 * closed.
 *
 * FAILURE ISOLATION (DM invariant 5): a failed publish marks ONLY Publishing
 * state — never Asset approval, Generation, or Production.
 */
import { randomUUID } from "node:crypto";
import { emitEvent, InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  CreatePublicationOutcome,
  DistributionReferenceRecord,
  PublicationActor,
  PublicationDeliveryPayload,
  PublicationPlatformAdapter,
  PublicationRecordView,
  PublicationStatus,
  PublicationVersionRecord,
  PublishOutcome,
  PublishingCommandError,
  PublishingCommandErrorReason,
  PublishingCommandResult,
  PublishingRepository,
  PublishingService,
} from "./types";
import { MAX_PUBLISH_ATTEMPTS, PUBLICATION_TRANSITIONS, TERMINAL_PUBLICATION_STATUSES } from "./types";

const REQUIRED_CAPABILITY = "production.publish";

const ok = <T>(value: T): PublishingCommandResult<T> => ({ ok: true, value });
const err = <T>(reason: PublishingCommandErrorReason, message: string): PublishingCommandResult<T> => ({
  ok: false,
  error: { reason, message },
});

const hasCapability = (actor: PublicationActor): boolean =>
  actor.capabilities.includes(REQUIRED_CAPABILITY as never);

export interface PublishingServiceDeps {
  repository: PublishingRepository;
  /**
   * D2.12-D: resolves subject ownership through narrow read-only upstream
   * ports. production/asset_version must resolve inside the actor's
   * organization; ai_creator_profile/campaign_creative return the
   * `unsupported` variant and FAIL CLOSED; a cross-org or absent subject
   * resolves to null (IDOR-safe).
   */
  resolveSubject: (orgId: string, subjectKind: string, subjectRef: string) => Promise<
    | { readonly kind: "production" | "asset_version"; readonly orgId: string }
    | { readonly kind: "ai_creator_profile" | "campaign_creative"; readonly unsupported: true }
    | null
  >;
  /**
   * QC handoff (plan section 9): composition root evaluates the subject's
   * durable QC state with the PURE evaluatePublicationEligibility function.
   * Null = no QC review exists (fail closed).
   */
  resolveEligibility: (orgId: string, subjectKind: string, subjectRef: string) => Promise<{
    readonly eligible: boolean;
    readonly reasons: readonly string[];
    /** The durable QC review id backing the verdict (approval-time stamp). */
    readonly reviewId?: string;
  } | null>;
  /**
   * D2.12-A rights seam — OPTIONAL and UNWIRED in Stage 2.12 production
   * composition. Absent port = no declared rights requirements = vacuous
   * pass. Test seams may inject a fake port to prove future blocking.
   */
  resolveRights?: (
    orgId: string,
    subjectKind: string,
    subjectRef: string,
  ) => Promise<{ readonly declared: boolean; readonly met: boolean; readonly reasons?: readonly string[] }>;
  /** Registered platform adapters (stratifit-media only in Stage 2.12). */
  adapters: readonly PublicationPlatformAdapter[];
  /** Defaults to an in-process publisher with no handlers (Stage-1 semantics). */
  publisher?: EventPublisher;
  eventIdFactory?: () => string;
  /** Max delivery attempts before `failed` becomes terminal. */
  maxPublishAttempts?: number;
}

export const createPublishingService = (deps: PublishingServiceDeps): PublishingService => {
  const repo = deps.repository;
  const publisher: EventPublisher = deps.publisher ?? new InProcessEventPublisher();
  const nextEventId = deps.eventIdFactory ?? randomUUID;
  const maxAttempts = deps.maxPublishAttempts ?? MAX_PUBLISH_ATTEMPTS;
  const adapterFor = (target: string): PublicationPlatformAdapter | undefined =>
    deps.adapters.find((a) => a.target === target);

  const emit = async (
    name: "publication.created" | "publication.published" | "publication.failed",
    payload: Record<string, unknown>,
    correlation: { organizationId: string; publicationId?: string },
  ) => {
    await emitEvent(publisher, {
      eventId: nextEventId(),
      name,
      correlation: { organizationId: correlation.organizationId, publicationId: correlation.publicationId },
      payload,
    });
  };

  /**
   * Audit actions are the FROZEN Stage 2.12 contract — exactly these eight:
   * created, revised, submitted, approved, scheduled, published, failed,
   * unpublished. No publish_started, no retry (the retry re-enters the
   * normal lifecycle and is covered by its subsequent actions).
   */
  const AUDIT_ACTIONS = [
    "publishing.publication_created",
    "publishing.publication_revised",
    "publishing.publication_submitted",
    "publishing.publication_approved",
    "publishing.publication_scheduled",
    "publishing.publication_published",
    "publishing.publication_failed",
    "publishing.publication_unpublished",
  ] as const;

  const auditEntry = (
    actor: PublicationActor,
    action: (typeof AUDIT_ACTIONS)[number],
    targetType: "publication" | "publication_version" | "distribution_reference",
    targetId: string,
    metadata?: Record<string, unknown>,
  ) => ({
    actorId: actor.operatorId ?? "system",
    action,
    targetType,
    targetId,
    ...(metadata !== undefined ? { metadata } : {}),
    organizationId: actor.organizationId,
    correlationId: actor.correlationId ?? null,
  });

  /** Actor/org/capability validation shared by every operator command. */
  const authorizeError = (actor: PublicationActor): PublishingCommandError | null => {
    if (!actor.operatorId) {
      return { reason: "missing_capability", message: "operator identity required" };
    }
    if (!hasCapability(actor)) {
      return { reason: "missing_capability", message: `missing capability: ${REQUIRED_CAPABILITY}` };
    }
    return null;
  };

  /** D2.12-D subject resolution (shared by create and gate re-checks). */
  const resolveSubjectOrError = async (
    actor: PublicationActor,
    subjectKind: PublicationRecordView["subjectKind"],
    subjectRef: string,
  ): Promise<{ error: PublishingCommandError } | { subject: { kind: string } }> => {
    if (subjectKind !== "production" && subjectKind !== "asset_version" && subjectKind !== "ai_creator_profile" && subjectKind !== "campaign_creative") {
      return { error: { reason: "invalid_request", message: `unknown subject kind: ${subjectKind}` } };
    }
    const resolved = await deps.resolveSubject(actor.organizationId, subjectKind, subjectRef);
    if (resolved === null) {
      return { error: { reason: "subject_not_found", message: "subject does not exist in this organization" } };
    }
    if ("unsupported" in resolved) {
      return {
        error: {
          reason: "subject_unsupported",
          message: `subject kind ${subjectKind} is not durably resolvable yet — failing closed`,
        },
      };
    }
    return { subject: resolved };
  };

  /** Full approve-gate evaluation (fail closed on ANY uncertainty). */
  const evaluateGate = async (
    actor: PublicationActor,
    subjectKind: PublicationRecordView["subjectKind"],
    subjectRef: string,
  ): Promise<PublishingCommandError | null> => {
    const gate = await deps.resolveEligibility(actor.organizationId, subjectKind, subjectRef);
    if (gate === null) {
      return { reason: "gate_not_approved", message: "no QC review exists for this subject — failing closed" };
    }
    if (!gate.eligible) {
      return { reason: "gate_not_approved", message: `QC gate not satisfied: ${gate.reasons.join("; ")}` };
    }
    // D2.12-A: the rights port is OPTIONAL; when unwired (production
    // Stage 2.12) there are no declared rights requirements — vacuous pass.
    if (deps.resolveRights) {
      const rights = await deps.resolveRights(actor.organizationId, subjectKind, subjectRef);
      if (rights.declared && !rights.met) {
        return {
          reason: "rights_requirements_unmet",
          message: `rights requirements unmet: ${(rights.reasons ?? ["declared requirements not met"]).join(";")}`,
        };
      }
    }
    return null;
  };

  const service: PublishingService = {
    async createPublication(actor, input) {
      const denied = authorizeError(actor);
      if (denied) return err<CreatePublicationOutcome>(denied.reason, denied.message);

      const subjectResult = await resolveSubjectOrError(actor, input.subjectKind, input.subjectRef);
      if ("error" in subjectResult) return err<CreatePublicationOutcome>(subjectResult.error.reason, subjectResult.error.message);

      // Deterministic dedupe: one publication per (org, subject, platform).
      // FROZEN (post-build review): no deduplication path exists. The
      // duplicate is detected inside the transaction (insert … on conflict
      // do nothing → null) and surfaces as a deterministic
      // publication_conflict; the UNIQUE constraint is the final backstop.
      const result = await repo.runInTransaction(async (tx) => {
        const publication = await tx.insertPublication({
          orgId: actor.organizationId,
          subjectKind: input.subjectKind,
          subjectRef: input.subjectRef,
          platformTarget: input.platformTarget,
          contentType: input.contentType,
          status: "draft",
        });
        if (publication === null) {
          // FROZEN (post-build review): a duplicate (org, subject, platform)
          // is a deterministic publication_conflict — the UNIQUE constraint
          // remains the final backstop; no 200-deduplication.
          throw new PublicationConflictSignal();
        }
        // D2.12-E: create provisions version 1 (the immutable snapshot,
        // EXACT frozen shape — no qc_review_id, no subject_snapshot).
        const version = await tx.insertVersion({
          orgId: actor.organizationId,
          publicationId: publication.id,
          versionNumber: 1,
          title: input.title,
          synopsis: input.synopsis ?? null,
          contentType: input.contentType,
          subjectKind: input.subjectKind,
          subjectRef: input.subjectRef,
          createdBy: actor.operatorId,
        });
        const updated = await tx.updatePublication(publication.id, { currentVersionId: version.id });
        await tx.appendAudit(
          auditEntry(actor, "publishing.publication_created", "publication", publication.id, {
            versionId: version.id,
            subjectKind: input.subjectKind,
            platformTarget: input.platformTarget,
          }),
        );
        return { publication: updated, version };
      }).catch((e) => {
        if (e instanceof PublicationConflictSignal) return e;
        throw e;
      });

      if (result instanceof PublicationConflictSignal) {
        return err<CreatePublicationOutcome>(
          "publication_conflict",
          "a publication already exists for this subject and platform",
        );
      }

      // Post-commit ONLY: a rolled-back transaction emits nothing.
      await emit(
        "publication.created",
        {
          publicationId: result.publication.id,
          versionId: result.version.id,
          subjectKind: input.subjectKind,
          subjectRef: input.subjectRef,
          platformTarget: input.platformTarget,
        },
        { organizationId: actor.organizationId, publicationId: result.publication.id },
      );
      return ok({ publication: result.publication, version: result.version });
    },

    async submit(actor, publicationId) {
      return simpleTransition(actor, publicationId, "draft", "pending_approval", "publishing.publication_submitted");
    },

    async approve(actor, publicationId) {
      const denied = authorizeError(actor);
      if (denied) return err<PublicationRecordView>(denied.reason, denied.message);

      const loaded = await repo.findPublicationById(actor.organizationId, publicationId);
      if (!loaded) return err("publication_not_found", "publication does not exist in this organization");
      if (loaded.status !== "pending_approval") {
        return err("invalid_transition", `approve requires pending_approval; publication is ${loaded.status}`);
      }
      const gate = await deps.resolveEligibility(actor.organizationId, loaded.subjectKind, loaded.subjectRef);
      if (gate === null) {
        return err<PublicationRecordView>("gate_not_approved", "no QC review exists for this subject — failing closed");
      }
      if (!gate.eligible) {
        return err<PublicationRecordView>("gate_not_approved", `QC gate not satisfied: ${gate.reasons.join("; ")}`);
      }      // D2.12-A: the rights port is OPTIONAL and UNWIRED in Stage 2.12
      // production composition. An injected port (future Rights stage, or a
      // test seam) makes declared unmet requirements BLOCK approval; an
      // absent port is a vacuous pass.
      if (deps.resolveRights) {
        const rights = await deps.resolveRights(actor.organizationId, loaded.subjectKind, loaded.subjectRef);
        if (rights.declared && !rights.met) {
          return err<PublicationRecordView>(
            "rights_requirements_unmet",
            `rights requirements unmet: ${(rights.reasons ?? ["declared requirements not met"]).join(";")}`,
          );
        }
      }

      const updated = await repo.runInTransaction(async (tx) => {
        // Concurrency guard: re-read inside the transaction; a concurrent
        // decision loses deterministically.
        const current = await tx.findPublicationById(actor.organizationId, publicationId);
        if (!current || current.status !== "pending_approval") throw new ConflictSignal();
        // Stamp the FROZEN approval-time QC reference on the publication.
        const next = await tx.updatePublication(publicationId, {
          status: "approved",
          ...(gate.reviewId !== undefined ? { qcReviewId: gate.reviewId } : {}),
        });
        await tx.appendAudit(auditEntry(actor, "publishing.publication_approved", "publication", publicationId));
        return next;
      }).catch((e) => {
        if (e instanceof ConflictSignal) return e;
        throw e;
      });

      if (updated instanceof ConflictSignal) {
        return err("conflict", "publication changed concurrently; re-read and retry");
      }
      return ok(updated);
    },

    async schedule(actor, publicationId, input) {
      const denied = authorizeError(actor);
      if (denied) return err<PublicationRecordView>(denied.reason, denied.message);

      const loaded = await repo.findPublicationById(actor.organizationId, publicationId);
      if (!loaded) return err("publication_not_found", "publication does not exist in this organization");
      if (loaded.status !== "approved") {
        return err("invalid_transition", `schedule requires approved; publication is ${loaded.status}`);
      }
      if (!input.scheduledFor) {
        return err("invalid_request", "scheduledFor is required");
      }
      const when = new Date(input.scheduledFor);
      if (Number.isNaN(when.getTime())) {
        return err("invalid_request", "scheduledFor is not a valid ISO timestamp");
      }
      if (when.getTime() < Date.now()) {
        return err("invalid_request", "scheduledFor must be in the future");
      }

      const updated = await repo.runInTransaction(async (tx) => {
        const current = await tx.findPublicationById(actor.organizationId, publicationId);
        if (!current || current.status !== "approved") throw new ConflictSignal();
        const next = await tx.updatePublication(publicationId, { status: "scheduled", scheduledFor: input.scheduledFor });
        await tx.appendAudit(
          auditEntry(actor, "publishing.publication_scheduled", "publication", publicationId, {
            scheduledFor: input.scheduledFor,
          }),
        );
        return next;
      }).catch((e) => {
        if (e instanceof ConflictSignal) return e;
        throw e;
      });

      if (updated instanceof ConflictSignal) {
        return err("conflict", "publication changed concurrently; re-read and retry");
      }
      return ok(updated);
    },

    async publish(actor, publicationId) {
      const denied = authorizeError(actor);
      if (denied) return err<PublishOutcome>(denied.reason, denied.message);

      const loaded = await repo.findPublicationById(actor.organizationId, publicationId);
      if (!loaded) return err("publication_not_found", "publication does not exist in this organization");
      // CRITICAL (approved correction): publish is valid ONLY from scheduled.
      if (loaded.status !== "scheduled") {
        return err("invalid_transition", `publish requires scheduled; publication is ${loaded.status}`);
      }
      const adapter = adapterFor(loaded.platformTarget);
      if (!adapter) return err("adapter_not_found", `no platform adapter for ${loaded.platformTarget}`);
      if (!loaded.currentVersionId) return err("invalid_request", "publication has no current version");

      const version = await repo.findVersionById(actor.organizationId, loaded.currentVersionId);
      if (!version) return err("invalid_request", "current version not found in this organization");

      const attemptNumber = loaded.attemptCount + 1;
      if (attemptNumber > maxAttempts) {
        return err("max_attempts_exhausted", `publish attempts exhausted (${maxAttempts}); failed is terminal`);
      }

      // Mark publishing BEFORE delivery (the intent record). The FROZEN
      // audit contract has NO publish_started action — the attempt is
      // recorded via attempt bookkeeping and the eventual published/failed
      // audit row.
      const inFlight = await repo.runInTransaction(async (tx) => {
        const current = await tx.findPublicationById(actor.organizationId, publicationId);
        if (!current || current.status !== "scheduled") throw new ConflictSignal();
        const next = await tx.updatePublication(publicationId, {
          status: "publishing",
          lastAttemptAt: new Date().toISOString(),
          attemptCount: attemptNumber,
        });
        return next;
      }).catch((e) => {
        if (e instanceof ConflictSignal) return e;
        throw e;
      });
      if (inFlight instanceof ConflictSignal) {
        return err("conflict", "publication changed concurrently; re-read and retry");
      }

      const payload: PublicationDeliveryPayload = {
        publicationId: loaded.id,
        versionId: version.id,
        versionNumber: version.versionNumber,
        title: version.title,
        synopsis: version.synopsis,
        contentType: version.contentType,
        platformTarget: loaded.platformTarget,
      };

      try {
        const delivery = await adapter.publish(payload);
        const published = await repo.runInTransaction(async (tx) => {
          const current = await tx.findPublicationById(actor.organizationId, publicationId);
          if (!current || current.status !== "publishing") throw new ConflictSignal();
          const ref = await tx.insertDistributionReference({
            orgId: actor.organizationId,
            publicationId: loaded.id,
            versionId: version.id,
            platformTarget: loaded.platformTarget,
            externalRef: delivery.externalId,
            deliveryOutcome: "delivered",
            failureReason: null,
          });
          const next = await tx.updatePublication(publicationId, { status: "published" });
          await tx.appendAudit(
            auditEntry(actor, "publishing.publication_published", "publication", publicationId, {
              attempt: attemptNumber,
              versionId: version.id,
              distributionReferenceId: ref.id,
            }),
          );
          return { publication: next, reference: ref };
        });

        await emit(
          "publication.published",
          {
            publicationId: loaded.id,
            versionId: version.id,
            versionNumber: version.versionNumber,
            platformTarget: loaded.platformTarget,
            externalRef: delivery.externalId,
          },
          { organizationId: actor.organizationId, publicationId: loaded.id },
        );
        return ok({ publication: published.publication, reference: published.reference });
      } catch (deliveryError) {
        const reason =
          deliveryError instanceof Error ? deliveryError.message : "platform delivery failed";
        const failed = await repo.runInTransaction(async (tx) => {
          const current = await tx.findPublicationById(actor.organizationId, publicationId);
          if (!current || current.status !== "publishing") throw new ConflictSignal();
          const ref = await tx.insertDistributionReference({
            orgId: actor.organizationId,
            publicationId: loaded.id,
            versionId: version.id,
            platformTarget: loaded.platformTarget,
            externalRef: null,
            deliveryOutcome: "failed",
            failureReason: reason,
          });
          const next = await tx.updatePublication(publicationId, {
            status: "failed",
            lastFailureReason: reason,
          });
          await tx.appendAudit(
            auditEntry(actor, "publishing.publication_failed", "publication", publicationId, {
              attempt: attemptNumber,
              versionId: version.id,
              failureReason: reason,
              distributionReferenceId: ref.id,
            }),
          );
          return { publication: next, reference: ref };
        });

        await emit(
          "publication.failed",
          {
            publicationId: loaded.id,
            versionId: version.id,
            platformTarget: loaded.platformTarget,
            attempt: attemptNumber,
            reason,
          },
          { organizationId: actor.organizationId, publicationId: loaded.id },
        );
        return ok({ publication: failed.publication, reference: failed.reference });
      }
    },

    async retry(actor, publicationId) {
      const denied = authorizeError(actor);
      if (denied) return err<PublicationRecordView>(denied.reason, denied.message);

      const loaded = await repo.findPublicationById(actor.organizationId, publicationId);
      if (!loaded) return err("publication_not_found", "publication does not exist in this organization");
      if (loaded.status !== "failed") {
        return err("invalid_transition", `retry requires failed; publication is ${loaded.status}`);
      }
      if (loaded.attemptCount >= maxAttempts) {
        return err("max_attempts_exhausted", `publish attempts exhausted (${maxAttempts}); failed is terminal`);
      }
      // D2.12-E: retry re-delivers the SAME current version — no new version.
      // The full gate is re-checked before the next publish attempt.
      const gateError = await evaluateGate(actor, loaded.subjectKind, loaded.subjectRef);
      if (gateError) return err<PublicationRecordView>(gateError.reason, gateError.message);

      // FROZEN audit contract: retry requires NO audit action — it re-enters
      // the normal lifecycle (submit → approve → schedule → publish) whose
      // actions cover it. State transition only.
      const updated = await repo.runInTransaction(async (tx) => {
        const current = await tx.findPublicationById(actor.organizationId, publicationId);
        if (!current || current.status !== "failed") throw new ConflictSignal();
        const next = await tx.updatePublication(publicationId, { status: "pending_approval" });
        return next;
      }).catch((e) => {
        if (e instanceof ConflictSignal) return e;
        throw e;
      });

      if (updated instanceof ConflictSignal) {
        return err("conflict", "publication changed concurrently; re-read and retry");
      }
      return ok(updated);
    },

    async unpublish(actor, publicationId) {
      const denied = authorizeError(actor);
      if (denied) return err<PublicationRecordView>(denied.reason, denied.message);

      const loaded = await repo.findPublicationById(actor.organizationId, publicationId);
      if (!loaded) return err("publication_not_found", "publication does not exist in this organization");
      if (loaded.status !== "published") {
        return err("invalid_transition", `unpublish requires published; publication is ${loaded.status}`);
      }

      const updated = await repo.runInTransaction(async (tx) => {
        const current = await tx.findPublicationById(actor.organizationId, publicationId);
        if (!current || current.status !== "published") throw new ConflictSignal();
        const next = await tx.updatePublication(publicationId, { status: "unpublished" });
        await tx.appendAudit(auditEntry(actor, "publishing.publication_unpublished", "publication", publicationId));
        return next;
      }).catch((e) => {
        if (e instanceof ConflictSignal) return e;
        throw e;
      });

      if (updated instanceof ConflictSignal) {
        return err("conflict", "publication changed concurrently; re-read and retry");
      }
      return ok(updated);
    },

    async revise(actor, publicationId, input) {
      const denied = authorizeError(actor);
      if (denied) return err<PublicationVersionRecord>(denied.reason, denied.message);

      const loaded = await repo.findPublicationById(actor.organizationId, publicationId);
      if (!loaded) return err("publication_not_found", "publication does not exist in this organization");
      // D2.12-E: corrections happen in draft; an active lifecycle requires a
      // new publication from the superseding subject.
      if (loaded.status !== "draft") {
        return err("invalid_transition", `revise requires draft; publication is ${loaded.status}`);
      }
      if (!loaded.currentVersionId) return err("invalid_request", "publication has no current version");
      const current = await repo.findVersionById(actor.organizationId, loaded.currentVersionId);
      if (!current) return err("invalid_request", "current version not found in this organization");

      const { version } = await repo.runInTransaction(async (tx) => {
        const fresh = await tx.findPublicationById(actor.organizationId, publicationId);
        if (!fresh || fresh.status !== "draft") throw new ConflictSignal();
        const next = await tx.insertVersion({
          orgId: actor.organizationId,
          publicationId,
          versionNumber: current.versionNumber + 1,
          title: input.title ?? current.title,
          synopsis: input.synopsis ?? current.synopsis,
          contentType: current.contentType,
          subjectKind: loaded.subjectKind,
          subjectRef: loaded.subjectRef,
          createdBy: actor.operatorId,
        });
        const updatedPub = await tx.updatePublication(publicationId, { currentVersionId: next.id });
        await tx.appendAudit(
          auditEntry(actor, "publishing.publication_revised", "publication_version", next.id, {
            versionNumber: next.versionNumber,
          }),
        );
        return { publication: updatedPub, version: next };
      });

      return ok(version);
    },

    async getPublication(actor, publicationId) {
      // IDOR-safe: everything is org-scoped by the actor's server-derived org.
      const publication = await repo.findPublicationById(actor.organizationId, publicationId);
      if (!publication) return err("publication_not_found", "publication does not exist in this organization");
      const versions = await repo.listVersions(actor.organizationId, publicationId);
      const references = await repo.listDistributionReferences(actor.organizationId, publicationId);
      return ok({ publication, versions, distributionReferences: references });
    },
  };

  /** Shared single-edge transition helper (submit). */
  async function simpleTransition(
    actor: PublicationActor,
    publicationId: string,
    from: PublicationStatus,
    to: PublicationStatus,
    auditAction: (typeof AUDIT_ACTIONS)[number],
  ): Promise<PublishingCommandResult<PublicationRecordView>> {
    const denied = authorizeError(actor);
    if (denied) return err<PublicationRecordView>(denied.reason, denied.message);
    const legal = PUBLICATION_TRANSITIONS[from].includes(to);
    if (!legal) return err("invalid_transition", `${from} -> ${to} is not a legal DM section 32.6 edge`);

    const loaded = await repo.findPublicationById(actor.organizationId, publicationId);
    if (!loaded) return err("publication_not_found", "publication does not exist in this organization");
    if (loaded.status !== from) {
      return err("invalid_transition", `${auditAction} requires ${from}; publication is ${loaded.status}`);
    }

    const updated = await repo.runInTransaction(async (tx) => {
      const current = await tx.findPublicationById(actor.organizationId, publicationId);
      if (!current || current.status !== from) throw new ConflictSignal();
      const next = await tx.updatePublication(publicationId, { status: to });
      await tx.appendAudit(auditEntry(actor, auditAction, "publication", publicationId));
      return next;
    }).catch((e) => {
      if (e instanceof ConflictSignal) return e;
      throw e;
    });

    if (updated instanceof ConflictSignal) {
      return err("conflict", "publication changed concurrently; re-read and retry");
    }
    return ok(updated);
  }

  return service;
};

/** Internal concurrency-conflict signal (never escapes the service). */
class ConflictSignal extends Error {
  constructor() {
    super("concurrent modification");
  }
}

/** Duplicate-create signal → deterministic publication_conflict (FROZEN). */
class PublicationConflictSignal extends Error {
  constructor() {
    super("publication already exists for this subject and platform");
  }
}
