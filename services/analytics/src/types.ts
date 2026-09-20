/**
 * Analytics-intake domain types (Stage 2.19, D2.19-A1..A6).
 *
 * services/analytics owns the IMMUTABLE intake family `analytics_events`:
 * the platform's FIRST PUBLIC UNAUTHENTICATED WRITE SURFACE. The single
 * write path is `recordEvent` — validate, rate-limit, resolve the content/
 * org SERVER-SIDE, hash the session, INSERT, then emit `analytics.received`
 * POST-INSERT (commit-before-event). There is no update, no delete, and NO
 * READ MODEL in this stage (D2.19-A6).
 *
 * HARD BOUNDARIES (frozen):
 *  - D2.19-A2: the ONLY event is the already-declared `analytics.received`;
 *    taxonomy stays at 36. envelope.eventId === row.ingest_event_id.
 *  - D2.19-A3: audience identity is ALWAYS server-derived; no client
 *    org/audience/operator/actor authority field exists in any input shape.
 *  - D2.19-A4: PII never enters properties (flat allowlist); raw session
 *    ids/IPs are never persisted — only the SHA-256 session hash.
 *  - D2.19-A5: rate limiting happens through the injectable
 *    AnalyticsRateLimiter port; no Redis/queue/worker infrastructure.
 *  - This service imports NO other service (no messaging import; the
 *    composition reuses messaging's generic fixed-window factory).
 */
import type { DomainEventEnvelope } from "@stratifit/contracts";

/** Frozen four-kind intake family (D2.19-P1; extensible only by migration). */
export const ANALYTICS_EVENT_KINDS = [
  "content_view",
  "content_progress",
  "content_complete",
  "content_share",
] as const;
export type AnalyticsEventKind = (typeof ANALYTICS_EVENT_KINDS)[number];

/** House command-result convention (discriminated, never throws). */
export type AnalyticsCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly reason: AnalyticsErrorReason; readonly message: string } };

export type AnalyticsErrorReason =
  | "invalid_event"
  | "content_not_found"
  | "duplicate"
  | "rate_limited"
  | "oversized";

export const ok = <T>(value: T): AnalyticsCommandResult<T> => ({ ok: true, value });
export const err = <T>(reason: AnalyticsErrorReason, message: string): AnalyticsCommandResult<T> => ({
  ok: false,
  error: { reason, message },
});

/** Flat, allowlisted properties (validated again at the service boundary). */
export type AnalyticsProperties = Record<string, string | number | boolean>;

/** Fully server-resolved input for recordEvent (the caller is the BFF). */
export interface NewAnalyticsEventInput {
  readonly eventType: AnalyticsEventKind;
  readonly contentRef: string | null;
  /** Server-derived audience principal (or null for anonymous beacons). */
  readonly audienceUserId: string | null;
  /** Raw client session id — hashed here, NEVER persisted raw (A4). */
  readonly sessionId: string;
  /**
   * Server-derived transport metadata (first x-forwarded-for value) used
   * ONLY for the rate-limit key — NEVER persisted, never echoed (A4).
   */
  readonly sourceIp: string | null;
  readonly properties: AnalyticsProperties | null;
  readonly clientTs: string | null;
  /** Client-supplied idempotency id (or null → server generates). */
  readonly eventId: string | null;
}

/** Outcome of an accepted/deduped intake (the ONLY public response shape). */
export interface AnalyticsRecordOutcome {
  readonly accepted: boolean;
  readonly eventId: string;
  readonly deduped: boolean;
}

/**
 * D2.19-A5 frozen budget: 30 events / 60s per SOURCE-IP key and 60 events /
 * 60s per SESSION key (the composition-level beacon budget; the port itself
 * is generic and injectable). Both keys are consumed on every event and BOTH
 * must concede.
 */
export const IP_LIMIT_PER_MINUTE = 30;
export const SESSION_LIMIT_PER_MINUTE = 60;

/** D2.19-A5: injectable fixed-window limiter port (clock-free; key-scoped). */
export interface AnalyticsRateLimiter {
  consume(key: string): Promise<boolean>;
}

export interface AnalyticsServiceDeps {
  readonly repository: AnalyticsRepository;
  readonly rateLimiter: AnalyticsRateLimiter;
  /** Post-insert event emission (house InProcessEventPublisher). */
  readonly publisher: (envelope: DomainEventEnvelope) => Promise<void>;
}

/**
 * Result handed to the composition for observability: the emitted envelope
 * is surfaced so tests can prove Case A ordering + the A2 relationship
 * without any analytics consumer existing.
 */
export interface AnalyticsRecordResult {
  readonly outcome: AnalyticsRecordOutcome;
  readonly emitted: DomainEventEnvelope | null;
}

export interface AnalyticsService {
  /**
   * The single intake command. Order is FROZEN:
   * validate → rate-limit → resolve content/org server-side → hash →
   * INSERT (commit) → emit `analytics.received` post-insert.
   */
  recordEvent(input: NewAnalyticsEventInput): Promise<AnalyticsCommandResult<AnalyticsRecordResult>>;
}

// ---------------------------------------------------------------------------
// Repository port (Drizzle adapter in repository.ts). IMMUTABLE: no update,
// no delete, no read-model queries exist by design (D2.19-A6).
// ---------------------------------------------------------------------------

export interface AnalyticsEventRecord {
  readonly id: string;
  readonly eventType: AnalyticsEventKind;
  readonly contentRef: string | null;
  readonly orgId: string | null;
  readonly audienceUserId: string | null;
  readonly sessionHash: string;
  readonly serverTs: Date;
  readonly ingestEventId: string;
}

export interface NewAnalyticsEventRow {
  readonly eventType: AnalyticsEventKind;
  readonly contentRef: string | null;
  readonly orgId: string | null;
  readonly audienceUserId: string | null;
  readonly sessionHash: string;
  readonly properties: AnalyticsProperties | null;
  readonly clientTs: Date | null;
  readonly ingestEventId: string;
}

export interface AnalyticsRepository {
  /** Idempotent insert; null = duplicate ingest_event_id (no second row). */
  insertEventIfAbsent(input: NewAnalyticsEventRow): Promise<AnalyticsEventRecord | null>;
  /** Fail-closed published-only content resolution (org resolved server-side). */
  findPublishedContentRef(contentRef: string): Promise<{ readonly id: string; readonly orgId: string } | null>;
}
