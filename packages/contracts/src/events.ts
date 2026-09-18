import { z } from "zod";

/**
 * Domain event names and envelope.
 *
 * Events communicate state changes; they never replace transactional domain
 * state. Handlers must be idempotent by event ID.
 */

export const DomainEventName = z.enum([
  // production
  "production.created",
  "production.updated",
  "production.approved",
  // jobs
  "job.created",
  "job.started",
  "job.progress",
  "job.completed",
  "job.failed",
  "job.cancelled",
  // generations (Stage 2.9, D2.9-2: aligned additively with the documented
  // EVENT_ARCHITECTURE catalog — started/cancelled join the pre-existing
  // created/completed/failed; generation.superseded stays deferred with the
  // corrections mechanism)
  "generation.created",
  "generation.started",
  "generation.completed",
  "generation.failed",
  "generation.cancelled",
  // assets
  "asset.created",
  "asset.approved",
  // publishing
  "publication.created",
  "publication.published",
  "publication.failed",
  // messaging
  "conversation.created",
  "message.created",
  "message.read",
  // identity & tenancy (Stage 2.2, approved D-5; producer: services/identity)
  "membership.granted",
  "membership.revoked",
  "membership.updated",
  "team.created",
  "team.archived",
  // analytics
  "analytics.received",
]);

export type DomainEventName = z.infer<typeof DomainEventName>;

export const DomainEventEnvelope = z.object({
  /** Unique event identity; handlers dedupe on this. */
  eventId: z.string().min(1),
  name: DomainEventName,
  /** Monotonic-ish ordering aid within an aggregate. */
  sequence: z.number().int().nonnegative().optional(),
  occurredAt: z.string().datetime(),
  /** Correlation IDs for observability across the platform. */
  correlation: z.object({
    organizationId: z.string().optional(),
    projectId: z.string().optional(),
    productionId: z.string().optional(),
    jobId: z.string().optional(),
    conversationId: z.string().optional(),
    publicationId: z.string().optional(),
  }),
  /** Schema-validated payload owned by the emitting domain. */
  payload: z.record(z.string(), z.unknown()),
});

export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelope>;

export const makeEnvelope = (input: {
  eventId: string;
  name: DomainEventName;
  occurredAt?: string;
  correlation?: DomainEventEnvelope["correlation"];
  payload: Record<string, unknown>;
}): DomainEventEnvelope => ({
  eventId: input.eventId,
  name: input.name,
  occurredAt: input.occurredAt ?? new Date().toISOString(),
  correlation: input.correlation ?? {},
  payload: input.payload,
});
