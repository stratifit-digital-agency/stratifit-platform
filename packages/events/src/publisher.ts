import {
  makeEnvelope,
  type DomainEventEnvelope,
  type DomainEventName,
} from "@stratifit/contracts";

/**
 * Event publishing abstraction.
 *
 * In-process implementation now; BullMQ/Redis or a message broker replaces the
 * transport later WITHOUT changing this interface. Handlers must be idempotent
 * by eventId — events communicate state changes, they never replace
 * transactional domain state.
 */

export interface EventPublisher {
  publish(envelope: DomainEventEnvelope): Promise<void>;
}

export interface EventHandler {
  (envelope: DomainEventEnvelope): Promise<void> | void;
}

/** Simple in-process publisher; useful for tests and single-process dev. */
export class InProcessEventPublisher implements EventPublisher {
  private readonly handlers: readonly EventHandler[];

  constructor(handlers: readonly EventHandler[] = []) {
    this.handlers = handlers;
  }

  async publish(envelope: DomainEventEnvelope): Promise<void> {
    for (const handler of this.handlers) await handler(envelope);
  }
}

/**
 * Idempotent handler wrapper: deduplicates by eventId. In production this
 * moves to durable storage (e.g., processed_events table keyed by eventId);
 * the interface does not change.
 */
export const idempotent = (handler: EventHandler): EventHandler => {
  const seen = new Set<string>();
  return async (envelope) => {
    if (seen.has(envelope.eventId)) return;
    seen.add(envelope.eventId);
    await handler(envelope);
  };
};

/** Convenience emitter used by domain modules. */
export const emitEvent = async (
  publisher: EventPublisher,
  input: {
    eventId: string;
    name: DomainEventName;
    correlation?: DomainEventEnvelope["correlation"];
    payload: Record<string, unknown>;
  },
): Promise<void> => {
  await publisher.publish(makeEnvelope(input));
};
