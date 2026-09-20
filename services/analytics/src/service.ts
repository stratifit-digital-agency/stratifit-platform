/**
 * Analytics-intake service (Stage 2.19, D2.19-A1..A6).
 *
 * ONE command: recordEvent. Frozen order (commit-before-event):
 *
 *   validate -> rate-limit (ip + session keys) -> resolve content/org
 *   SERVER-SIDE (fail-closed, published-only) -> hash session ->
 *   INSERT analytics_events (commit) -> emit `analytics.received` POST-INSERT
 *
 * The emitted envelope.eventId === the persisted row's ingest_event_id
 * (D2.19-A2 relationship). Replay (duplicate ingest_event_id) inserts
 * nothing, is reported deduped:true, and NEVER re-emits the event.
 * A publisher failure after the insert propagates to the caller for
 * observability, but the committed row is NEVER rolled back.
 * The service NEVER throws to callers - every outcome is a typed result.
 */
import { createHash, randomUUID } from "node:crypto";
import { makeEnvelope, type DomainEventEnvelope } from "@stratifit/contracts";
import { ANALYTICS_EVENT_KINDS, err, ok } from "./types";
import type {
  AnalyticsCommandResult,
  AnalyticsEventKind,
  AnalyticsRecordResult,
  AnalyticsService,
  AnalyticsServiceDeps,
  NewAnalyticsEventInput,
} from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_SESSION_LEN = 16;
const MAX_SESSION_LEN = 128;
const MAX_PROP_KEYS = 8;
const MAX_PROP_STR = 200;
/** D2.19-P6: client timestamps more than 1h in the future are rejected. */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

/** Deterministic session hashing - the raw id is NEVER persisted (A4). */
export const hashSessionId = (sessionId: string): string =>
  createHash("sha256").update(sessionId, "utf8").digest("hex");

/**
 * D2.19-A4 intake PII guard: obvious personal-data keys are rejected
 * outright (defense in depth; the beacon schema enforces the same list).
 */
const PII_KEYS: ReadonlySet<string> = new Set([
  "email", "e-mail", "phone", "telephone", "mobile", "name", "fullname",
  "full_name", "firstname", "first_name", "lastname", "last_name", "address",
  "street", "city", "zipcode", "zip", "postal", "postal_code", "ssn", "dob",
  "birthday", "birthdate", "ip", "ip_address", "device_id", "user_agent",
]);

const validateProperties = (
  properties: Record<string, string | number | boolean> | null,
): string | null => {
  if (properties === null) return null;
  const entries = Object.entries(properties);
  if (entries.length>MAX_PROP_KEYS) return "properties exceeds 8 keys";
  for (const [key, value] of entries) {
    if (!/^[a-z_]{1,32}$/.test(key)) return "invalid property key: " + key.slice(0, 12);
    if (PII_KEYS.has(key)) return "property key rejected by the PII guard: " + key;
    if (typeof value === "string") {
      if (value.length>MAX_PROP_STR) return "property " + key + " exceeds 200 chars";
    } else if (typeof value !== "number" && typeof value !== "boolean") {
      return "property " + key + " has a disallowed type";
    }
  }
  return null;
};

export const createAnalyticsService = (deps: AnalyticsServiceDeps): AnalyticsService => {
  const repo = deps.repository;
  return {
    async recordEvent(input: NewAnalyticsEventInput): Promise<AnalyticsCommandResult<AnalyticsRecordResult>> {
      // 1. Validation (fail-closed, before any I/O).
      if (!(ANALYTICS_EVENT_KINDS as readonly string[]).includes(input.eventType)) {
        return err("invalid_event", "eventType is not in the frozen intake family");
      }
      if (input.sessionId.length<MIN_SESSION_LEN||input.sessionId.length>MAX_SESSION_LEN) {
        return err("invalid_event", "sessionId must be 16..128 chars");
      }
      if (input.audienceUserId !== null && !UUID_RE.test(input.audienceUserId)) {
        return err("invalid_event", "audienceUserId must be a valid uuid (server-derived)");
      }
      if (input.contentRef !== null && !UUID_RE.test(input.contentRef)) {
        return err("invalid_event", "contentRef must be a valid uuid");
      }
      const propsError = validateProperties(input.properties);
      if (propsError) return err("invalid_event", propsError);
      let clientTs: Date | null = null;
      if (input.clientTs !== null) {
        const parsed = new Date(input.clientTs);
        if (Number.isNaN(parsed.getTime())) return err("invalid_event", "clientTs is not a valid ISO timestamp");
        if (parsed.getTime()>Date.now()+MAX_FUTURE_SKEW_MS) {
          return err("invalid_event", "clientTs is too far in the future");
        }
        clientTs = parsed;
      }

      // 2. Rate limiting (D2.19-A5): both keys must concede. The IP is
      // server-derived transport metadata and is NEVER persisted.
      const sessionHash = hashSessionId(input.sessionId);
      const ipAllowed = await deps.rateLimiter.consume("ip:" + (input.sourceIp ?? "unknown"));
      if (!ipAllowed) return err("rate_limited", "too many analytics events from this source");
      const sessionAllowed = await deps.rateLimiter.consume("sess:" + sessionHash);
      if (!sessionAllowed) return err("rate_limited", "too many analytics events for this session");

      // 3. Content resolution - SERVER-SIDE, fail-closed, published-only.
      let contentRef: string | null = null;
      let orgId: string | null = null;
      if (input.contentRef !== null) {
        const content = await repo.findPublishedContentRef(input.contentRef);
        if (!content) return err("content_not_found", "no published public content for this contentRef");
        contentRef = content.id;
        orgId = content.orgId;
      }

      // 4. Idempotency id: client-supplied or server-generated.
      const ingestEventId = input.eventId ?? ("analytics_" + randomUUID());

      // 5. INSERT (its own commit) - before ANY event emission (Case A order).
      let inserted;
      try {
        inserted = await repo.insertEventIfAbsent({
          eventType: input.eventType as AnalyticsEventKind,
          contentRef,
          orgId,
          audienceUserId: input.audienceUserId,
          sessionHash,
          properties: input.properties,
          clientTs,
          ingestEventId,
        });
      } catch (e) {
        // Case B: insert failed -> NOTHING is emitted.
        return err("invalid_event", "analytics insert failed: " + (e as Error).message);
      }

      // Case D: duplicate ingest_event_id -> deduped, NO second emission.
      if (!inserted) {
        return ok<AnalyticsRecordResult>({
          outcome: { accepted: true, eventId: ingestEventId, deduped: true },
          emitted: null,
        });
      }

      // 6. POST-INSERT emission (Case A: commit strictly precedes the event).
      const envelope: DomainEventEnvelope = makeEnvelope({
        eventId: ingestEventId,
        name: "analytics.received",
        occurredAt: inserted.serverTs.toISOString(),
        correlation: orgId ? { organizationId: orgId } : {},
        payload: { eventType: inserted.eventType, contentRef: inserted.contentRef, sessionHash: inserted.sessionHash },
      });
      // Case C: a publisher failure propagates (observable) but the row
      // stays committed - never rolled back (house post-commit semantics).
      await deps.publisher(envelope);

      return ok<AnalyticsRecordResult>({
        outcome: { accepted: true, eventId: ingestEventId, deduped: false },
        emitted: envelope,
      });
    },
  };
};
