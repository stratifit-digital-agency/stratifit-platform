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
  // assets (Stage 2.10: rejected joins the pre-existing created/approved,
  // mirroring the DM section 35 "future extensions" list — additive only)
  "asset.created",
  "asset.approved",
  "asset.rejected",
  // qc (Stage 2.11: the three documented EVENT_ARCHITECTURE names —
  // qc.requested/approved/rejected, D2.11-4. qc.changes_requested is NOT a
  // contract event; the state transition is captured by review state + audit.
  // QC state never drives asset approval — separate aggregates, hard
  // domain-separation rule.)
  "qc.requested",
  "qc.approved",
  "qc.rejected",
  // publishing (Stage 2.13, D2.13-1: unpublished joins the pre-existing
  // created/published/failed — the pre-approved EVENT_ARCHITECTURE
  // "Approved extensions from DOMAIN_MODEL §35" name; the audience consumer
  // needs it to retire projected public content on takedown, otherwise the
  // projection goes stale. Additive only.)
  "publication.created",
  "publication.published",
  "publication.failed",
  "publication.unpublished",
  // messaging
  "conversation.created",
  "message.created",
  "message.read",
  // messaging (Stage 2.17, D2.17-4/D2.17-5: the three pre-justified
  // EVENT_ARCHITECTURE §8 extension names join additively — the takeover fact
  // and the lead lifecycle facts. No notification.* events exist; delivery
  // emits no domain events by design.)
  "conversation.taken_over",
  "lead.created",
  "lead.assigned",
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
