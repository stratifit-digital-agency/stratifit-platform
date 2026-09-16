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
  // generations
  "generation.created",
  "generation.completed",
  "generation.failed",
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
