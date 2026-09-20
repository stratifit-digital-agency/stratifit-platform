/**
 * Audience domain service (Stage 2.13, D2.13-1..D2.13-5).
 *
 * Event-driven projection of committed publishing facts into the durable
 * PUBLIC CONTENT aggregate (DM section 20). INVARIANT 10: public content
 * originates ONLY from an approved publication — the consumers below are the
 * single write path; there is no second content universe.
 *
 * Consumer rules (frozen):
 *  - projectPublished: idempotency key = payload.versionId (verified BUILD
 *    STEP 0: the existing publication.published payload carries the
 *    publication-version id under `versionId`). Duplicate events are silent
 *    no-ops; slug collisions resolve through the bounded probe + hash
 *    fallback; the DB UNIQUEs are the final backstops.
 *  - unpublishContent: flips published → unpublished. Missing projection or
 *    already-unpublished rows are silent no-ops (idempotent takedown).
 *  - No-op operations produce NO audit mutation; successful mutations are
 *    audited in the SAME transaction (D2.4-1 seam) and roll back together.
 *  - The service never mutates the publishing family and never imports it.
 */
import { createHash } from "node:crypto";
import type {
  AudienceCommandResult,
  AudienceRepository,
  AudienceService,
  AudienceServiceDeps,
  MarkNotificationsReadInput,
  NotificationResolution,
  ProjectionOutcome,
  PublicContentRecord,
  PublicContentType,
  PublicationPublishedEvent,
  PublicationUnpublishedEvent,
  RecordNotificationOutcome,
} from "./types";
import {
  AUDIENCE_AUDIT_ACTIONS,
  CONTENT_TYPE_MAPPING,
  NOTIFICATION_RECORDED_AUDIT,
  SYSTEM_ACTOR_ID,
  err,
  ok,
} from "./types";

// ---------------------------------------------------------------------------
// Slug strategy (D2.13-2): deterministic, URL-safe, globally unique.
// ---------------------------------------------------------------------------

export const slugify = (title: string): string => {
  const base = title
    .normalize("NFKD")
    // Strip combining diacritics left by NFKD decomposition.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "content";
};

/** Approved bounded probe: base, base-2 … base-9, then the 6-hex hash fallback. */
const MAX_PROBE = 9;

const hashSuffix = (publicationVersionId: string): string =>
  createHash("sha256").update(publicationVersionId).digest("hex").slice(0, 6);

/**
 * Collision resolution: probes candidate slugs against the EXISTING rows
 * (pre-insert check), then relies on the DB UNIQUE(slug) as the final
 * backstop (a lost race surfaces as 23505 and is retried with the next
 * candidate by the service loop below).
 */
const resolveSlug = async (
  tx: Pick<AudienceRepository, "findBySlug">,
  title: string,
  publicationVersionId: string,
): Promise<string> => {
  const base = slugify(title);
  for (let n = 1; n <= MAX_PROBE; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if ((await tx.findBySlug(candidate)) === null) return candidate;
  }
  return `${base}-${hashSuffix(publicationVersionId)}`;
};

// ---------------------------------------------------------------------------
// Envelope validation (strict, fail-closed on malformed events)
// ---------------------------------------------------------------------------

interface PublishPayload {
  readonly publicationId: string;
  readonly versionId: string;
  readonly title: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parsePublishedPayload = (payload: unknown): PublishPayload | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const publicationId = p.publicationId;
  const versionId = p.versionId;
  const title = p.title;
  if (typeof publicationId !== "string" || !UUID_RE.test(publicationId)) return null;
  if (typeof versionId !== "string" || !UUID_RE.test(versionId)) return null;
  if (typeof title !== "string" || title.trim().length === 0) return null;
  return { publicationId, versionId, title };
};

const parseUnpublishedPayload = (payload: unknown): { publicationId: string } | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const publicationId = p.publicationId;
  if (typeof publicationId !== "string" || !UUID_RE.test(publicationId)) return null;
  return { publicationId };
};

/** D2.13-3 mapping, validated against the DB CHECK taxonomy. */
const mapContentType = (value: unknown): PublicContentType | null => {
  if (typeof value !== "string") return null;
  const mapped = CONTENT_TYPE_MAPPING[value as keyof typeof CONTENT_TYPE_MAPPING];
  return mapped ?? null;
};

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export const createAudienceService = (deps: AudienceServiceDeps): AudienceService => {
  const repo = deps.repository;

  return {
    async projectPublished(event: PublicationPublishedEvent) {
      const envelope = event.envelope;
      if (envelope.name !== "publication.published") {
        return err("invalid_event", `expected publication.published, got ${envelope.name}`);
      }
      const payload = parsePublishedPayload(envelope.payload);
      if (!payload) {
        return err("invalid_event", "publication.published payload missing valid publicationId/versionId/title");
      }
      const contentType = mapContentType(envelope.payload.contentType);
      if (!contentType) {
        return err("invalid_event", "publication.published payload contentType is not mappable (D2.13-3)");
      }
      const orgId = envelope.correlation.organizationId;
      if (typeof orgId !== "string" || !UUID_RE.test(orgId)) {
        return err("invalid_event", "publication.published envelope missing correlation.organizationId");
      }

      // Idempotency: same publication_version_id → silent NO-OP (no audit).
      const existing = await repo.findByPublicationVersionId(payload.versionId);
      if (existing) return ok<ProjectionOutcome>({ kind: "noop_duplicate" });

      const projected = await repo.runInTransaction(async (tx) => {
        // Re-check inside the transaction (unique constraints backstop anyway).
        const dup = await tx.findByPublicationVersionId(payload.versionId);
        if (dup) return null;
        const slug = await resolveSlug(tx, payload.title, payload.versionId);
        const inserted = await tx.insertContent({
          orgId,
          publicationId: payload.publicationId,
          publicationVersionId: payload.versionId,
          slug,
          contentType,
          title: payload.title,
          synopsis: typeof envelope.payload.synopsis === "string" ? envelope.payload.synopsis : null,
          mediaRefs: [],
          publishedAt: envelope.occurredAt ? new Date(envelope.occurredAt) : new Date(),
          categories: [],
        });
        await tx.appendAudit({
          actorId: SYSTEM_ACTOR_ID,
          action: AUDIENCE_AUDIT_ACTIONS[0],
          subjectKind: "public_content",
          subjectId: inserted.id,
          organizationId: orgId,
          correlationId: envelope.correlation.publicationId ?? payload.publicationId,
          causationId: envelope.eventId,
          payload: { slug, contentType, publicationVersionId: payload.versionId },
        });
        return inserted;
      }).catch((e) => {
        // Lost slug race: DB UNIQUE(slug) fired — retry once with the next
        // candidate by letting the caller loop; surfaced as conflict here.
        if (e instanceof Error && e.message.startsWith("unique violation")) {
          return e;
        }
        throw e;
      });

      if (projected instanceof Error) {
        return err("projection_conflict", projected.message);
      }
      if (projected === null) return ok<ProjectionOutcome>({ kind: "noop_duplicate" });
      return ok<ProjectionOutcome>({ kind: "projected", contentId: projected.id, slug: projected.slug });
    },

    async unpublishContent(event: PublicationUnpublishedEvent) {
      const envelope = event.envelope;
      if (envelope.name !== "publication.unpublished") {
        return err("invalid_event", `expected publication.unpublished, got ${envelope.name}`);
      }
      const payload = parseUnpublishedPayload(envelope.payload);
      if (!payload) {
        return err("invalid_event", "publication.unpublished payload missing valid publicationId");
      }

      // Pre-classify the no-op (observability only — both are silent, no audit).
      const existing = await repo.findByPublicationId(payload.publicationId);
      const alreadyUnpublished = existing?.status === "unpublished";

      const updated: AudienceCommandResult<PublicContentRecord | null> = await repo.runInTransaction(async (tx) => {
        // The ONLY sanctioned mutation: published → unpublished. setStatus
        // no-ops (returns null) when the row is missing or already flipped.
        const next = await tx.setStatus(payload.publicationId, "unpublished");
        if (!next) return ok<PublicContentRecord | null>(null); // missing/already — NO-OP, no audit
        await tx.appendAudit({
          actorId: SYSTEM_ACTOR_ID,
          action: AUDIENCE_AUDIT_ACTIONS[1],
          subjectKind: "public_content",
          subjectId: next.id,
          organizationId: next.orgId,
          correlationId: envelope.correlation.publicationId ?? payload.publicationId,
          causationId: envelope.eventId,
          payload: { slug: next.slug },
        });
        return ok<PublicContentRecord | null>(next);
      });

      if (!updated.ok) return updated;
      if (updated.value === null) {
        return ok<ProjectionOutcome>(
          alreadyUnpublished ? { kind: "noop_already_unpublished" } : { kind: "noop_missing" },
        );
      }
      return ok<ProjectionOutcome>({ kind: "unpublished", contentId: updated.value.id, slug: updated.value.slug });
    },

    listContent: (): Promise<readonly PublicContentRecord[]> => repo.listPublished(),
    // Published-only at the service layer too (the public reader filters
    // again — defense in depth against unpublished exposure).
    getContentBySlug: async (slug: string): Promise<PublicContentRecord | null> => {
      const row = await repo.findBySlug(slug);
      return row && row.status === "published" ? row : null;
    },

    // -------------------------------------------------------------------
    // Stage 2.14 — watch progress (authenticated audience only).
    // principal.userId is the SERVER-DERIVED audience identity; no caller-
    // supplied user/org authority participates anywhere below (D2.14 plan).
    // -------------------------------------------------------------------
    async getProgress(principal, query) {
      const limit = Math.min(Math.max(query?.limit ?? 50, 1), 200);
      return repo.listProgressByUser(principal.userId, limit);
    },

    async upsertProgress(principal, input) {
      // Deterministic validation BEFORE any data access (never throws).
      if (!Number.isInteger(input.positionSeconds) || input.positionSeconds < 0) {
        return err("invalid_position", "positionSeconds must be an integer >= 0");
      }
      if (!UUID_RE.test(input.contentRef)) {
        return err("content_not_found", "contentRef must be a valid uuid");
      }

      // Owner context: the audience user's own org, derived server-side.
      const user = await repo.findAudienceUserById(principal.userId);
      if (!user) return err("user_not_found", "audience user does not exist or is not active");

      // Eligibility: progress may only reference PUBLISHED public content.
      const content = await repo.findPublishedContentById(input.contentRef);
      if (!content) return err("content_not_found", "no published public content for this contentRef");

      const record = await repo.upsertProgress({
        orgId: user.orgId,
        audienceUserId: principal.userId,
        contentRef: input.contentRef,
        positionSeconds: input.positionSeconds,
      });
      return ok({ kind: "saved" as const, record });
    },

    // -------------------------------------------------------------------
    // Stage 2.18 - notifications (D2.18-SELECT, D2.18-N1..N5).
    // -------------------------------------------------------------------
    async recordNotification(resolution) {
      // The composition root resolves the recipient server-side (D2.18-N1);
      // this method only handles the already-resolved outcome shapes.
      if (resolution.kind === "suppress_self_send") {
        return ok<RecordNotificationOutcome>({ kind: "noop_duplicate" });
      }
      if (resolution.kind === "noop_missing") {
        return err("content_not_found", "message/conversation source rows missing");
      }
      if (resolution.kind === "invalid_event") {
        return err("invalid_event", resolution.message);
      }
      const n = resolution.notification;
      if (!UUID_RE.test(n.audienceUserId) || !UUID_RE.test(n.orgId)) {
        return err("invalid_event", "notification recipient/org ids must be uuids");
      }
      if (n.eventId.length === 0) {
        return err("invalid_event", "notification eventId must be non-empty");
      }
      const recorded = await repo.runInTransaction(async (tx) => {
        // Idempotent by UNIQUE(event_id): replay/duplicate inserts NOTHING,
        // so replay can never create a duplicate row OR a duplicate audit
        // record (audit is written only on the non-conflict insert path).
        const inserted = await tx.insertNotificationIfAbsent(n);
        if (!inserted) return null;
        await tx.appendAudit({
          actorId: SYSTEM_ACTOR_ID,
          action: NOTIFICATION_RECORDED_AUDIT,
          subjectKind: "notification",
          subjectId: inserted.id,
          organizationId: n.orgId,
          causationId: n.eventId,
          payload: { kind: n.kind, sourceKind: n.sourceKind },
        });
        return inserted;
      });
      if (!recorded) return ok<RecordNotificationOutcome>({ kind: "noop_duplicate" });
      return ok<RecordNotificationOutcome>({ kind: "recorded", notificationId: recorded.id });
    },

    async listNotifications(principal, query) {
      const limit = Math.min(Math.max(query?.limit ?? 50, 1), 200);
      return repo.listNotificationsByUser(principal.userId, limit);
    },

    async unreadNotifications(principal) {
      // D2.18-N5: derived - COUNT(read_at IS NULL) for the owner only.
      return repo.countUnreadByUser(principal.userId);
    },

    async markNotificationsRead(principal, input: MarkNotificationsReadInput) {
      const updated = await repo.markNotificationsRead(principal.userId, input);
      const unreadCount = await repo.countUnreadByUser(principal.userId);
      return ok({ updated, unreadCount });
    },
  };
};
