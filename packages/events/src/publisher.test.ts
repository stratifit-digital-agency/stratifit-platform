import { describe, expect, it, vi } from "vitest";
import { emitEvent, idempotent, InProcessEventPublisher } from "./publisher";
import type { DomainEventEnvelope } from "@stratifit/contracts";

const envelope = (id: string): DomainEventEnvelope => ({
  eventId: id,
  name: "job.completed",
  occurredAt: new Date().toISOString(),
  correlation: { jobId: "job-1" },
  payload: { jobId: "job-1" },
});

describe("InProcessEventPublisher", () => {
  it("delivers to all handlers", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const publisher = new InProcessEventPublisher([a, b]);
    await publisher.publish(envelope("e1"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("idempotent wrapper", () => {
  it("drops duplicate event IDs", async () => {
    const handler = vi.fn();
    const deduped = idempotent(handler);
    await deduped(envelope("e1"));
    await deduped(envelope("e1"));
    await deduped(envelope("e2"));
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("emitEvent", () => {
  it("builds and publishes a valid envelope", async () => {
    const publisher = new InProcessEventPublisher();
    const spy = vi.spyOn(publisher, "publish").mockResolvedValue();
    await emitEvent(publisher, {
      eventId: "e9",
      name: "publication.published",
      correlation: { publicationId: "pub-1" },
      payload: { ok: true },
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "e9", name: "publication.published" }),
    );
  });
});
