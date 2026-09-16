import { describe, expect, it } from "vitest";
import {
  InMemoryPublicationStore,
  PublishingEngine,
  StratifitMediaAdapter,
  type PublicationRecord,
} from "./publishing";

const record = (): PublicationRecord => ({
  publicationId: "pub-1",
  contentRef: "master://prod-1/final",
  title: "Night Harbor",
  contentType: "short",
  target: "stratifit-media",
  status: "approved",
});

describe("PublishingEngine", () => {
  it("publishes via the Stratifit Media adapter and lists published content", async () => {
    const store = new InMemoryPublicationStore();
    const engine = new PublishingEngine(store, [new StratifitMediaAdapter(store)]);
    await engine.publish(record(), "stratifit-media");

    const published = await store.listPublished("stratifit-media");
    expect(published).toHaveLength(1);
    expect(published[0]?.title).toBe("Night Harbor");
    expect(published[0]?.status).toBe("published");
  });

  it("does not expose unpublished records through the public read API", async () => {
    const store = new InMemoryPublicationStore();
    await store.save(record()); // approved, not published
    expect(await store.listPublished("stratifit-media")).toHaveLength(0);
  });

  it("marks failures without invalidating the record", async () => {
    const store = new InMemoryPublicationStore();
    const failing: PlatformAdapterLike = { target: "external", publish: async () => { throw new Error("down"); } };
    const engine = new PublishingEngine(store, [failing]);
    await expect(engine.publish(record(), "external")).rejects.toThrow(/failed/);
    const saved = await store.get("pub-1");
    expect(saved?.status).toBe("failed");
  });
});

type PlatformAdapterLike = { target: string; publish(r: PublicationRecord): Promise<{ externalId?: string }> };
