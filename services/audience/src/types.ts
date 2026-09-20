/**
 * Audience-domain service types (Stage 2.13, approved plan; D2.13-1..D2.13-5).
 *
 * services/audience owns the PUBLIC CONTENT aggregate (DM section 20,
 * aggregate 20; bounded context 12 core only). INVARIANT 10: public content
 * must originate from an approved publication — there is no second content
 * universe. Rows are created ONLY by the audience consumer of
 * `publication.published` and retired from public reads by the
 * `publication.unpublished` consumer (D2.13-1). This module declares the
 * injectable ports; the Drizzle adapter implements them. No database imports
 * here.
 *
 * HARD BOUNDARIES:
 *  - Publishing owns publication state; audience only consumes committed
 *    facts (post-commit envelopes) and never mutates the publishing family.
 *  - The public read API exposes ONLY the whitelist in public.ts — never
 *    org identity, publication internals, or infrastructure identifiers.
 *  - People (context 4) is not durable; creator_profile_ref stays reserved
 *    and is never exposed.
 */
import type { DomainEventEnvelope } from "@stratifit/contracts";

/** DM section 20 public content taxonomy (DB CHECK mirrors this exactly). */
export const PUBLIC_CONTENT_TYPES = [
  "film",
  "movie",
  "series",
  "episode",
  "short",
  "comedy",
  "skit",
  "music",
  "music-video",
  "documentary",
  "live-program",
  "trailer",
  "advertisement",
] as const;
export type PublicContentType = (typeof PUBLIC_CONTENT_TYPES)[number];

/** Public visibility: the ONLY mutable aspect of the aggregate. */
export type PublicContentStatus = "published" | "unpublished";

/** D2.13-3: publication contentType (7 values) → public taxonomy mapping. */
export const CONTENT_TYPE_MAPPING: Readonly<
  Record<"film" | "series" | "episode" | "short" | "music" | "documentary" | "trailer", PublicContentType>
> = {
  film: "film",
  series: "series",
  episode: "episode",
  short: "short",
  music: "music",
  documentary: "documentary",
  trailer: "trailer",
};

/**
 * Metadata-only public media references. Deliberately coarse: ids and
 * classification only — never storage paths, signed URLs, provider
 * identifiers, or binary locations (binaries stay behind storage).
 */
export interface PublicMediaRef {
  /** Opaque asset-version id reference (metadata only, no resolution). */
  readonly assetVersionId?: string;
  /** Coarse classification for UI selection (poster/thumbnail/master/…). */
  readonly kind?: string;
  readonly byteSize?: number;
  readonly mime?: string;
}

/** Full durable row view (service-internal; never crosses the public API). */
export interface PublicContentRecord {
  readonly id: string;
  readonly orgId: string;
  readonly publicationId: string;
  readonly publicationVersionId: string;
  readonly slug: string;
  readonly contentType: PublicContentType;
  readonly title: string;
  readonly synopsis: string | null;
  readonly mediaRefs: PublicMediaRef[];
  readonly durationSeconds: number | null;
  readonly creatorProfileRef: string | null;
  readonly seriesRef: string | null;
  readonly episodeNumber: number | null;
  readonly categories: readonly string[];
  readonly publishedAt: Date;
  readonly status: PublicContentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * PUBLIC-SAFE PROJECTION (whitelist). Exactly the fields Media may see:
 * slug-addressed, no org/publication/production/asset/generation/QC/
 * infrastructure identifiers. `contentRef` is the OPAQUE public_content.id
 * (list keys / links) — never an internal subject id.
 */
export interface PublicContentView {
  readonly contentRef: string;
  readonly slug: string;
  readonly title: string;
  readonly synopsis?: string;
  readonly contentType: PublicContentType;
  readonly publishedAt: string;
  readonly durationSeconds?: number;
  readonly categories: readonly string[];
  readonly mediaRefs: readonly PublicMediaRef[];
}

/**
 * D2.13-1 consumer input: the committed `publication.published` envelope.
 * Payload contract (verified BUILD STEP 0): { publicationId, versionId,
 * versionNumber, platformTarget, externalRef } — `versionId` is the
 * publication-version id and the projection idempotency key.
 */
export interface PublicationPublishedEvent {
  readonly envelope: DomainEventEnvelope;
}

/** D2.13-1 consumer input: the committed `publication.unpublished` envelope. */
export interface PublicationUnpublishedEvent {
  readonly envelope: DomainEventEnvelope;
}

/** Slug generation port (deterministic; collision-probing lives in the repo). */
export type SlugGenerator = (title: string) => string;

/**
 * Same-transaction audit seam (D2.4-1 reused). The adapter receives the
 * open transaction and appends inside it; rollback removes both.
 */
export interface AudienceAuditWriter {
  appendWithin(
    tx: unknown,
    entry: {
      readonly actorId: string;
      readonly action: string;
      readonly subjectKind: string;
      readonly subjectId: string;
      readonly organizationId?: string | null;
      readonly correlationId?: string | null;
      readonly causationId?: string | null;
      readonly payload?: Record<string, unknown>;
    },
  ): Promise<void>;
}

/** FROZEN audit actions (Stage 2.13 + Stage 2.18 D2.18-P3). */
export const AUDIENCE_AUDIT_ACTIONS = [
  "audience.public_content_projected",
  "audience.public_content_unpublished",
  /** Stage 2.18: consumer-projection audit row (same tx as the insert). */
  "audience.notification_recorded",
] as const;
/** Stage 2.18 audit action for the notification consumer (index 2 above). */
export const NOTIFICATION_RECORDED_AUDIT = "audience.notification_recorded" as const;

/**
 * System-originated actor identity for audit rows written by the event
 * consumers. audit_log.actor_id is a uuid (no FK, opaque to admin-audit),
 * so the consumers use this DETERMINISTIC system UUID — never a fabricated
 * operator row id, never the literal string "system".
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000000";

/** Command result convention (house style: discriminated, never throws). */
export type AudienceCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly reason: AudienceErrorReason; readonly message: string } };

export type AudienceErrorReason =
  | "invalid_event"
  | "projection_conflict"
  | "content_not_found"
  /** Stage 2.14: watch-progress command failures (owner-scoped audience state). */
  | "invalid_position"
  | "user_not_found"
  | "unknown_notification";

export const ok = <T>(value: T): AudienceCommandResult<T> => ({ ok: true, value });
export const err = <T>(reason: AudienceErrorReason, message: string): AudienceCommandResult<T> => ({
  ok: false,
  error: { reason, message },
});

// ---------------------------------------------------------------------------
// Stage 2.18 - IN-APP NOTIFICATIONS (D2.18-SELECT, D2.18-N1..N5)
// ---------------------------------------------------------------------------

/** Notification kinds. Stage 2.18 ships `conversation_reply` ONLY
 *  (social kinds deferred per D2.18-N2 / D2.15-3). */
export const NOTIFICATION_KINDS = ["conversation_reply"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Owner-scoped source addressing (D2.13-4 precedent: opaque to the owner). */
export const NOTIFICATION_SOURCE_KINDS = ["conversation"] as const;
export type NotificationSourceKind = (typeof NOTIFICATION_SOURCE_KINDS)[number];

/** Full durable row view (service-internal; never crosses the public API). */
export interface NotificationRecord {
  readonly id: string;
  readonly orgId: string;
  readonly audienceUserId: string;
  readonly kind: NotificationKind;
  readonly sourceKind: NotificationSourceKind | null;
  readonly sourceRef: string | null;
  readonly eventId: string;
  readonly title: string;
  readonly body: string | null;
  /** NULL = unread. Unread count is DERIVED from this (D2.18-N5). */
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/**
 * PUBLIC-SAFE PROJECTION (whitelist). Exactly the fields Media may see.
 * `notificationRef` is the OPAQUE row id (owner-scoped addressing);
 * eventId / orgId / audienceUserId are structurally ABSENT.
 */
export interface NotificationView {
  readonly notificationRef: string;
  readonly kind: NotificationKind;
  readonly sourceRef?: string;
  readonly title: string;
  readonly body?: string;
  readonly readAt: string | null;
  readonly createdAt: string;
}

/** Consumer input for recordNotification - fully resolved server-side. */
export interface NewNotificationInput {
  readonly orgId: string;
  readonly audienceUserId: string;
  readonly kind: NotificationKind;
  readonly sourceKind: NotificationSourceKind | null;
  readonly sourceRef: string | null;
  readonly eventId: string;
  readonly title: string;
  readonly body: string | null;
}

/** Owner-facing mark-read selector (D2.18-P2). */
export type MarkNotificationsReadInput =
  | { readonly all: true }
  | { readonly ids: readonly string[] };

/** Outcome of an owner-scoped mark-read. */
export interface MarkNotificationsReadOutcome {
  readonly updated: number;
  readonly unreadCount: number;
}

/**
 * Server-side resolution of a committed `message.created` fact (D2.18-N1):
 * the composition root reads the durable message + conversation rows and
 * hands the FULLY RESOLVED recipient/preview here. `services/audience`
 * stays messaging-agnostic - it never imports Messaging internals.
 */
export type NotificationResolution =
  | { readonly kind: "notify"; readonly notification: NewNotificationInput }
  | { readonly kind: "suppress_self_send" }
  | { readonly kind: "noop_missing" }
  | { readonly kind: "invalid_event"; readonly message: string };

// ---------------------------------------------------------------------------
// Repository port (implemented by the Drizzle adapter in repository.ts)
// ---------------------------------------------------------------------------

export interface NewPublicContentInput {
  readonly orgId: string;
  readonly publicationId: string;
  readonly publicationVersionId: string;
  readonly slug: string;
  readonly contentType: PublicContentType;
  readonly title: string;
  readonly synopsis: string | null;
  readonly mediaRefs: readonly PublicMediaRef[];
  readonly publishedAt: Date;
  readonly categories: readonly string[];
}

export interface AudienceRepository {
  /** Idempotency lookup — the ONLY dedupe path (D2.13-1/§5 rules). */
  findByPublicationVersionId(publicationVersionId: string): Promise<PublicContentRecord | null>;
  findByPublicationId(publicationId: string): Promise<PublicContentRecord | null>;
  findBySlug(slug: string): Promise<PublicContentRecord | null>;
  /** Published-only public reads. */
  listPublished(): Promise<readonly PublicContentRecord[]>;
  /** Insert with org/slug conflict signal (23505) surfaced to the caller. */
  insertContent(input: NewPublicContentInput): Promise<PublicContentRecord>;
  /** The ONLY sanctioned mutation: published → unpublished. */
  setStatus(publicationId: string, status: PublicContentStatus): Promise<PublicContentRecord | null>;
  // ---------------------------------------------------------------------
  // Stage 2.14 — WATCH PROGRESS (audience-owner transactional state).
  // Owner-scoped: every method is keyed by the SERVER-DERIVED audience
  // userId; no client authority participates (D2.14 plan).
  // ---------------------------------------------------------------------
  /** The audience user's own org (server-derived owner context). */
  findAudienceUserById(audienceUserId: string): Promise<{ readonly id: string; readonly orgId: string } | null>;
  /** Published content lookup for the progress eligibility check. */
  findPublishedContentById(contentRef: string): Promise<{ readonly id: string; readonly orgId: string } | null>;
  /** Idempotent upsert keyed by UNIQUE(audience_user_id, content_ref). */
  upsertProgress(input: {
    readonly orgId: string;
    readonly audienceUserId: string;
    readonly contentRef: string;
    readonly positionSeconds: number;
  }): Promise<WatchProgressRecord>;
  /** Owner-scoped list, newest first. */
  listProgressByUser(audienceUserId: string, limit: number): Promise<readonly WatchProgressRecord[]>;
  // ---------------------------------------------------------------------
  // Stage 2.18 - NOTIFICATIONS (audience-owner state; consumer write path).
  // ---------------------------------------------------------------------
  /** Insert (consumer); idempotent by UNIQUE(event_id) - null on conflict. */
  insertNotificationIfAbsent(input: NewNotificationInput): Promise<NotificationRecord | null>;
  /** Owner-scoped feed, newest first. */
  listNotificationsByUser(audienceUserId: string, limit: number): Promise<readonly NotificationRecord[]>;
  /** D2.18-N5: DERIVED unread count - COUNT(read_at IS NULL). */
  countUnreadByUser(audienceUserId: string): Promise<number>;
  /** Mark read: only the owner's rows, only where read_at IS NULL. */
  markNotificationsRead(
    audienceUserId: string,
    input: MarkNotificationsReadInput,
  ): Promise<number>;
  /** D2.4-1: transaction scope for mutation + same-tx audit. */
  runInTransaction<T>(work: (tx: AudienceTransaction) => Promise<T>): Promise<T>;
}

export interface AudienceTransaction {
  findByPublicationVersionId(publicationVersionId: string): Promise<PublicContentRecord | null>;
  findByPublicationId(publicationId: string): Promise<PublicContentRecord | null>;
  findBySlug(slug: string): Promise<PublicContentRecord | null>;
  insertContent(input: NewPublicContentInput): Promise<PublicContentRecord>;
  setStatus(publicationId: string, status: PublicContentStatus): Promise<PublicContentRecord | null>;
  appendAudit(entry: {
    readonly actorId: string;
    readonly action: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly organizationId?: string | null;
    readonly correlationId?: string | null;
    readonly causationId?: string | null;
    readonly payload?: Record<string, unknown>;
  }): Promise<void>;
  /** Stage 2.18: idempotent notification insert (UNIQUE(event_id) backstop). */
  insertNotificationIfAbsent(input: NewNotificationInput): Promise<NotificationRecord | null>;
}

// ---------------------------------------------------------------------------
// Service ports
// ---------------------------------------------------------------------------

export interface AudienceServiceDeps {
  readonly repository: AudienceRepository;
  readonly slugify: SlugGenerator;
}

/** What the consumer returns so the composition can log/observe. */
export type ProjectionOutcome =
  | { readonly kind: "projected"; readonly contentId: string; readonly slug: string }
  | { readonly kind: "unpublished"; readonly contentId: string; readonly slug: string }
  | { readonly kind: "noop_duplicate" }
  | { readonly kind: "noop_missing" }
  | { readonly kind: "noop_already_unpublished" };

export interface AudienceService {
  /** D2.13-1 consumer: publication.published → public_content (idempotent). */
  projectPublished(event: PublicationPublishedEvent): Promise<AudienceCommandResult<ProjectionOutcome>>;
  /** D2.13-1 consumer: publication.unpublished → status flip (idempotent). */
  unpublishContent(event: PublicationUnpublishedEvent): Promise<AudienceCommandResult<ProjectionOutcome>>;
  /** Public reads (published-only). */
  listContent(): Promise<readonly PublicContentRecord[]>;
  getContentBySlug(slug: string): Promise<PublicContentRecord | null>;
  // ---------------------------------------------------------------------
  // Stage 2.14 — WATCH PROGRESS commands (authenticated audience only).
  // principal.userId is ALWAYS the server-derived audience identity — the
  // port deliberately accepts no user/org authority from callers.
  // ---------------------------------------------------------------------
  getProgress(principal: { readonly userId: string }, query?: { readonly limit?: number }): Promise<readonly WatchProgressRecord[]>;
  upsertProgress(
    principal: { readonly userId: string },
    input: { readonly contentRef: string; readonly positionSeconds: number },
  ): Promise<AudienceCommandResult<WatchProgressUpsertOutcome>>;
  // ---------------------------------------------------------------------
  // Stage 2.18 - NOTIFICATIONS. recordNotification is the CONSUMER write
  // path (system-originated, idempotent by eventId); the owner commands
  // take the SERVER-DERIVED audience principal and never accept user/org
  // authority from callers.
  // ---------------------------------------------------------------------
  /** Consumer: insert one notification (idempotent by eventId) + same-tx audit. */
  recordNotification(
    resolution: NotificationResolution,
  ): Promise<AudienceCommandResult<RecordNotificationOutcome>>;
  /** Owner: feed, newest first. */
  listNotifications(principal: { readonly userId: string }, query?: { readonly limit?: number }): Promise<readonly NotificationRecord[]>;
  /** Owner: derived unread count (D2.18-N5). */
  unreadNotifications(principal: { readonly userId: string }): Promise<number>;
  /** Owner: mark read (NULL->set only; foreign-owner ids no-op; idempotent). */
  markNotificationsRead(
    principal: { readonly userId: string },
    input: MarkNotificationsReadInput,
  ): Promise<AudienceCommandResult<MarkNotificationsReadOutcome>>;
}

/** Discriminated outcome of the consumer's recordNotification. */
export type RecordNotificationOutcome =
  | { readonly kind: "recorded"; readonly notificationId: string }
  | { readonly kind: "noop_duplicate" };
// ---------------------------------------------------------------------------
// Stage 2.14 - WATCH PROGRESS (audience platform state, DM section 21)
// ---------------------------------------------------------------------------

/** One row of the (audience user, public content) upsert family. */
export interface WatchProgressRecord {
  readonly audienceUserId: string;
  readonly contentRef: string;
  readonly positionSeconds: number;
  readonly updatedAt: string;
}

/** Discriminated outcome of an owner-scoped progress upsert. */
export type WatchProgressUpsertOutcome =
  | { readonly kind: "saved"; readonly record: WatchProgressRecord }
  | { readonly kind: "invalid_position" }
  | { readonly kind: "content_not_found" }
  | { readonly kind: "user_not_found" };
