/**
 * Analytics beacon composition for the Media BFF (Stage 2.19).
 *
 * The ONLY public unauthenticated write surface on the platform. The lib
 * builds the frozen composition once (D2.19-P3/P4) and exposes two pure
 * helpers the route consumes:
 *
 *  - buildBeaconInput: strict-Zod-validated body + SERVER-DERIVED transport
 *    metadata -> the fully server-resolved service input. Never trusts a
 *    client authority field; identity is server-derived when present.
 *  - toBeaconOutcome: the whitelisted 202 body (P5).
 *
 * Composition reuses messaging's GENERIC fixed-window factory (no
 * service->service coupling: services/analytics imports nothing from
 * messaging; the media-app -> public-service import is an allowed edge).
 * The Media-owned InProcessEventPublisher([]) has ZERO consumers: no fake
 * consumer is introduced just to exercise `analytics.received` (frozen).
 */
import { InProcessEventPublisher } from "@stratifit/events";
import { createFixedWindowRateLimiter } from "@stratifit/messaging";
import {
  createAnalyticsService,
  createDrizzleAnalyticsRepository,
  IP_LIMIT_PER_MINUTE,
  SESSION_LIMIT_PER_MINUTE,
  type AnalyticsRecordOutcome,
  type NewAnalyticsEventInput,
} from "@stratifit/analytics";
import { z } from "zod";

const repository = createDrizzleAnalyticsRepository({
  databaseUrl: process.env.DATABASE_URL as string,
});

/**
 * D2.19-A5 frozen composition: 30 events / 60s per source-IP key and 60
 * events / 60s per session key (both consumed on every event; either
 * exhaustion -> 429). Exported for guard tests; the limiter itself is
 * injectable for tests.
 */
export const beaconRateLimiterConfig = {
  windowMs: 60_000,
  ipLimit: IP_LIMIT_PER_MINUTE,
  sessionLimit: SESSION_LIMIT_PER_MINUTE,
} as const;

export const beaconRateLimiter = createFixedWindowRateLimiter({
  windowMs: beaconRateLimiterConfig.windowMs,
  keyLimits: { ip: beaconRateLimiterConfig.ipLimit, sess: beaconRateLimiterConfig.sessionLimit },
});

/** Media-owned publisher with ZERO consumers (frozen: no fake consumer). */
const publisher = new InProcessEventPublisher([]);

const service = createAnalyticsService({
  repository,
  rateLimiter: beaconRateLimiter,
  publisher: (envelope) => publisher.publish(envelope),
});

/**
 * D2.19-A4 intake PII guard (mirror of the service list): obvious
 * personal-data keys are rejected at the schema boundary itself.
 */
const PII_KEYS = [
  "email", "e-mail", "phone", "telephone", "mobile", "name", "fullname",
  "full_name", "firstname", "first_name", "lastname", "last_name",
  "address", "street", "city", "zipcode", "zip", "postal", "postal_code",
  "ssn", "dob", "birthday", "birthdate", "ip", "ip_address", "device_id",
  "user_agent",
] as const;

const propertyKey = z
  .string()
  .regex(/^[a-z_]{1,32}$/)
  .refine((k) => !(PII_KEYS as readonly string[]).includes(k));

/** D2.19-A1 exact beacon schema (strict; unknown fields rejected). */
export const beaconSchema = z
  .object({
    eventType: z.enum(["content_view", "content_progress", "content_complete", "content_share"]),
    contentRef: z.string().uuid().nullable().optional(),
    audienceUserId: z.string().optional(),
    sessionId: z.string().min(16).max(128),
    properties: z
      .record(propertyKey, z.union([z.string().max(200), z.number(), z.boolean()]))
      .nullable()
      .optional(),
    clientTs: z.string().datetime({ offset: true }).nullable().optional(),
    eventId: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();

export type BeaconBody = z.infer<typeof beaconSchema>;

const FIRST_XFF = /^[0-9a-fA-F:.]{7,45}$/;

/** Server-derived transport metadata: first sane x-forwarded-for entry, else null. */
export const sourceIpOf = (request: Request): string | null => {
  const raw = request.headers.get("x-forwarded-for");
  if (!raw) return null;
  const first = raw.split(",")[0]!.trim();
  return FIRST_XFF.test(first) ? first : null;
};

/** Body + transport metadata -> the fully server-resolved service input. */
export const buildBeaconInput = (
  body: BeaconBody,
  identity: { userId: string; emailVerified: boolean } | null,
  request: Request,
): NewAnalyticsEventInput => ({
  eventType: body.eventType,
  // Identity is SERVER-DERIVED: a client-supplied audienceUserId is IGNORED;
  // when a session principal exists it overrides the field entirely (A3).
  audienceUserId: identity ? identity.userId : null,
  sessionId: body.sessionId,
  sourceIp: sourceIpOf(request),
  properties: body.properties ?? null,
  clientTs: buildClientTs(body),
  eventId: body.eventId ?? null,
  contentRef: body.contentRef ?? null,
});

const buildClientTs = (body: BeaconBody): string | null => body.clientTs ?? null;

/** Whitelisted 202 outcome (P5); no internal ids, no limiter internals. */
export const toBeaconOutcome = (outcome: AnalyticsRecordOutcome) => ({
  accepted: outcome.accepted,
  eventId: outcome.eventId,
  deduped: outcome.deduped,
});

export const recordBeacon = (input: NewAnalyticsEventInput) => service.recordEvent(input);
