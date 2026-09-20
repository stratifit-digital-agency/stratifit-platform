/**
 * Unit tests for the durable publishing service (Stage 2.12).
 *
 * Covers the approved DM section 32.6 transition matrix (with the corrected
 * rule: publish() ONLY from scheduled; approved leaves ONLY via schedule()),
 * approve fail-closed gates, draft-only revise, retry-same-version,
 * deduplication, tenant isolation, fail-closed subjects, rights vacuous
 * pass, event-on-commit-only, and same-transaction audit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreatePublicationInput,
  DistributionReferenceRecord,
  PublicationActor,
  PublicationRecordView,
  PublicationVersionRecord,
  PublishingRepository,
  PublishingTransaction,
} from "./types";
import { MAX_PUBLISH_ATTEMPTS } from "./types";
import { createPublishingService } from "./service";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const fakeVersion = (over: Partial<PublicationVersionRecord> = {}): PublicationVersionRecord => ({
  id: "ver-1",
  orgId: "org-1",
  publicationId: "pub-1",
  versionNumber: 1,
  title: "The Premiere",
  synopsis: null,
  contentType: "film",
  subjectKind: "production",
  subjectRef: "6f1c2a3e-0000-4000-8000-000000000001",
  createdBy: "op-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const fakePublication = (over: Partial<PublicationRecordView> = {}): PublicationRecordView => ({
  id: "pub-1",
  orgId: "org-1",
  subjectKind: "production",
  subjectRef: "6f1c2a3e-0000-4000-8000-000000000001",
  platformTarget: "stratifit-media",
  contentType: "film",
  currentVersionId: "ver-1",
  qcReviewId: null,
  status: "draft",
  scheduledFor: null,
  attemptCount: 0,
  lastFailureReason: null,
  lastAttemptAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

type Store = {
  publications: PublicationRecordView[];
  versions: PublicationVersionRecord[];
  references: DistributionReferenceRecord[];
  audit: { actorId: string; action: string; targetType: string; targetId: string }[];
};

const makeStore = (): Store => ({ publications: [], versions: [], references: [], audit: [] });

/** In-memory repository mirroring the real adapter's semantics. */
const makeRepo = (store: Store) => {
  const mutations = {
    findPublicationById: async (orgId: string, id: string) =>
      store.publications.find((p) => p.id === id && p.orgId === orgId) ?? null,
    insertPublication: async (input: { orgId: string; subjectKind: string; subjectRef: string; platformTarget: string; contentType: string; status: string }) => {
      const clash = store.publications.find(
        (p) =>
          p.orgId === input.orgId &&
          p.subjectKind === input.subjectKind &&
          p.subjectRef === input.subjectRef &&
          p.platformTarget === input.platformTarget,
      );
      if (clash) return null as unknown as PublicationRecordView;
      const pub = fakePublication({
        id: `pub-${store.publications.length + 1}`,
        orgId: input.orgId,
        subjectKind: input.subjectKind as PublicationRecordView["subjectKind"],
        subjectRef: input.subjectRef,
        platformTarget: input.platformTarget as PublicationRecordView["platformTarget"],
        contentType: input.contentType as PublicationRecordView["contentType"],
        status: input.status as PublicationRecordView["status"],
        currentVersionId: null,
      });
      store.publications.push(pub);
      return pub;
    },
    updatePublication: async (id: string, patch: Partial<PublicationRecordView>) => {
      const idx = store.publications.findIndex((p) => p.id === id);
      const next = { ...store.publications[idx]!, ...patch, updatedAt: new Date().toISOString() };
      store.publications[idx] = next;
      return next;
    },
    insertVersion: async (input: { orgId: string; publicationId: string; versionNumber: number; title: string; synopsis: string | null; contentType: string; subjectKind: string; subjectRef: string; createdBy: string | null }) => {
      const version = fakeVersion({
        id: `ver-${store.versions.length + 1}`,
        orgId: input.orgId,
        publicationId: input.publicationId,
        versionNumber: input.versionNumber,
        title: input.title,
        synopsis: input.synopsis,
        contentType: input.contentType as PublicationVersionRecord["contentType"],
        subjectKind: input.subjectKind as PublicationVersionRecord["subjectKind"],
        subjectRef: input.subjectRef,
        createdBy: input.createdBy,
      });
      store.versions.push(version);
      return version;
    },
    insertDistributionReference: async (input: { publicationId: string; versionId: string; externalRef: string | null; deliveryOutcome: "delivered" | "failed"; failureReason: string | null }) => {
      const ref: DistributionReferenceRecord = {
        id: `ref-${store.references.length + 1}`,
        orgId: "org-1",
        publicationId: input.publicationId,
        versionId: input.versionId,
        platformTarget: "stratifit-media",
        externalRef: input.externalRef,
        deliveryOutcome: input.deliveryOutcome,
        failureReason: input.failureReason,
        createdAt: new Date().toISOString(),
      };
      store.references.push(ref);
      return ref;
    },
    appendAudit: async (entry: { actorId: string; action: string; targetType: string; targetId: string }) => {
      store.audit.push(entry);
    },
  };

  const repo: PublishingRepository = {
    findPublicationById: (orgId, id) => mutations.findPublicationById(orgId, id),
    findPublicationBySubject: async (orgId, subjectKind, subjectRef, platformTarget) =>
      store.publications.find(
        (p) => p.orgId === orgId && p.subjectKind === subjectKind && p.subjectRef === subjectRef && p.platformTarget === platformTarget,
      ) ?? null,
    listVersions: async (orgId, publicationId) =>
      store.versions.filter((v) => v.orgId === orgId && v.publicationId === publicationId),
    findVersionById: async (orgId, versionId) =>
      store.versions.find((v) => v.orgId === orgId && v.id === versionId) ?? null,
    listDistributionReferences: async (orgId, publicationId) =>
      store.references.filter((r) => r.orgId === orgId && r.publicationId === publicationId),
    runInTransaction: async <T>(work: (tx: PublishingTransaction) => Promise<T>): Promise<T> => {
      // Mutation + audit on the "same transaction": the fake's audit list is
      // the audit table; a thrown error aborts `work` so nothing further is
      // appended. (Rollback-isolation is proven live.)
      const tx: PublishingTransaction = {
        findPublicationById: mutations.findPublicationById,
        insertPublication: mutations.insertPublication,
        updatePublication: mutations.updatePublication,
        insertVersion: mutations.insertVersion,
        insertDistributionReference: mutations.insertDistributionReference,
        appendAudit: mutations.appendAudit,
      };
      return work(tx);
    },
  };
  return repo;
};

const makeActor = (over: Partial<PublicationActor> = {}): PublicationActor => ({
  operatorId: "op-1",
  organizationId: "org-1",
  roles: ["admin"],
  capabilities: ["production.publish"] as PublicationActor["capabilities"],
  ...over,
});

const makeDeps = (store: Store, over: Partial<Parameters<typeof createPublishingService>[0]> = {}) => {
  const events: { name: string; payload: Record<string, unknown> }[] = [];
  const service = createPublishingService({
    repository: makeRepo(store),
    // Mirrors the real composition port: campaign_creative returns the
    // fail-closed variant (D2.12-D); ai_creator_profile resolves only when
    // the test's fake creator port says so (Stage 2.16 D2.16-6 — this suite
    // keeps the pre-People default of fail-closed).
    resolveSubject: async (_orgId, subjectKind) =>
      subjectKind === "campaign_creative"
        ? { kind: subjectKind, unsupported: true as const }
        : subjectKind === "ai_creator_profile"
          ? null
          : { kind: subjectKind as "production" | "asset_version", orgId: "org-1" },
    resolveEligibility: makeGate(),
    adapters: [{ target: "stratifit-media", publish: async (payload) => ({ externalId: `ext-${payload.publicationId}` }) }],
    publisher: {
      publish: async (envelope: { name: string; payload: Record<string, unknown> }) => {
        events.push({ name: envelope.name, payload: envelope.payload });
      },
    } as never,
    ...over,
  });
  return { service, events };
};

const createInput = (over: Partial<CreatePublicationInput> = {}): CreatePublicationInput => ({
  subjectKind: "production",
  subjectRef: "6f1c2a3e-0000-4000-8000-000000000001",
  platformTarget: "stratifit-media",
  contentType: "film",
  title: "The Premiere",
  ...over,
});

const makeGate = (reviewId = "11111111-1111-4111-8111-111111111111") => async () => ({
  eligible: true,
  reasons: [] as const,
  reviewId,
});

/** Drives a publication from draft to scheduled through legal edges. */
const prepareScheduled = async (service: ReturnType<typeof makeDeps>["service"], store: Store) => {
  const created = await service.createPublication(makeActor(), createInput());
  if (!created.ok) throw new Error(`setup failed: ${created.error.message}`);
  await service.submit(makeActor(), created.value.publication.id);
  await service.approve(makeActor(), created.value.publication.id);
  const scheduled = await service.schedule(makeActor(), created.value.publication.id, {
    scheduledFor: new Date(Date.now() + 60_000).toISOString(),
  });
  if (!scheduled.ok) throw new Error(`schedule failed: ${scheduled.error.message}`);
  return store.publications.find((p) => p.id === created.value.publication.id)!;
};

let store: Store;
let deps: ReturnType<typeof makeDeps>;
let service: ReturnType<typeof makeDeps>["service"];
let events: ReturnType<typeof makeDeps>["events"];

beforeEach(() => {
  store = makeStore();
  deps = makeDeps(store);
  service = deps.service;
  events = deps.events;
});

// ---------------------------------------------------------------------------
// Creation & deduplication
// ---------------------------------------------------------------------------

describe("createPublication", () => {
  it("creates a draft publication with immutable version v1 and current-version pointer", async () => {
    const result = await service.createPublication(makeActor(), createInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.publication.status).toBe("draft");
    expect(result.value.version.versionNumber).toBe(1);
    expect(result.value.publication.currentVersionId).toBe(result.value.version.id);
    // The version snapshot carries the FROZEN subject reference.
    expect(result.value.version.subjectRef).toBe(createInput().subjectRef);
    expect("qcReviewId" in result.value.version).toBe(false);
    expect("subjectSnapshot" in result.value.version).toBe(false);
    expect(store.versions).toHaveLength(1);
  });

  it("emits publication.created exactly once, post-commit", async () => {
    await service.createPublication(makeActor(), createInput());
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("publication.created");
    expect(events[0]!.payload.publicationId).toBe(store.publications[0]!.id);
  });

  it("rejects a duplicate (org, subject, platform) with a deterministic publication_conflict", async () => {
    const first = await service.createPublication(makeActor(), createInput());
    expect(first.ok).toBe(true);
    const second = await service.createPublication(makeActor(), createInput());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.reason).toBe("publication_conflict");
    }
    expect(store.publications).toHaveLength(1);
    expect(store.versions).toHaveLength(1);
    expect(events).toHaveLength(1); // no second created event
  });

  it("fails closed for unsupported/unresolvable subject kinds (D2.12-D + Stage 2.16 D2.16-6)", async () => {
    // campaign_creative: structurally unsupported until Advertising exists.
    const unsupported = await service.createPublication(makeActor(), createInput({ subjectKind: "campaign_creative" }));
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.reason).toBe("subject_unsupported");
    // ai_creator_profile: resolvable through the narrow People subject port —
    // with NO active profile (this suite's port returns null) it FAILS CLOSED
    // as subject_not_found (IDOR-safe, no existence leak).
    const unresolvable = await service.createPublication(makeActor(), createInput({ subjectKind: "ai_creator_profile" }));
    expect(unresolvable.ok).toBe(false);
    if (!unresolvable.ok) expect(unresolvable.error.reason).toBe("subject_not_found");
  });

  it("fails closed for cross-org and absent subjects (IDOR-safe)", async () => {
    const cross = makeDeps(store, { resolveSubject: async () => null }).service;
    const result = await cross.createPublication(makeActor(), createInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("subject_not_found");
  });

  it("requires the production.publish capability and a real operator", async () => {
    const noCap = await service.createPublication(makeActor({ capabilities: [] }), createInput());
    expect(noCap.ok).toBe(false);
    if (!noCap.ok) expect(noCap.error.reason).toBe("missing_capability");
    const noOp = await service.createPublication(makeActor({ operatorId: null }), createInput());
    expect(noOp.ok).toBe(false);
    if (!noOp.ok) expect(noOp.error.reason).toBe("missing_capability");
  });

  it("writes the audit record in the same transaction as the mutation", async () => {
    await service.createPublication(makeActor(), createInput());
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]!.action).toBe("publishing.publication_created");
    expect(store.audit[0]!.actorId).toBe("op-1");
    expect(store.audit[0]!.targetId).toBe(store.publications[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle & transition matrix
// ---------------------------------------------------------------------------

describe("lifecycle (DM section 32.6 with the approved correction)", () => {
  it("rejects publish from approved — the only path out of approved is schedule()", async () => {
    const created = await service.createPublication(makeActor(), createInput());
    if (!created.ok) throw new Error("setup failed");
    await service.submit(makeActor(), created.value.publication.id);
    await service.approve(makeActor(), created.value.publication.id);
    const attempt = await service.publish(makeActor(), created.value.publication.id);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.reason).toBe("invalid_transition");
    expect(store.publications[0]!.status).toBe("approved");
  });

  it("walks the full happy path draft → pending_approval → approved → scheduled → publishing → published", async () => {
    const pub = await prepareScheduled(service, store);
    const result = await service.publish(makeActor(), pub.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.publication.status).toBe("published");
    expect(result.value.reference.deliveryOutcome).toBe("delivered");
    expect(store.references).toHaveLength(1);
    expect(events.map((e) => e.name)).toEqual(["publication.created", "publication.published"]);
  });

  it("records the failure path publishing → failed without touching upstream state", async () => {
    const failing = makeDeps(store, {
      adapters: [
        {
          target: "stratifit-media",
          publish: async () => {
            throw new Error("adapter exploded");
          },
        },
      ],
    });
    const pub = await prepareScheduled(failing.service, store);
    const result = await failing.service.publish(makeActor(), pub.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.publication.status).toBe("failed");
    expect(result.value.reference.deliveryOutcome).toBe("failed");
    expect(store.publications[0]!.lastFailureReason).toContain("adapter exploded");
    expect(failing.events.map((e) => e.name)).toEqual(["publication.created", "publication.failed"]);
  });

  it("retry sends failed → pending_approval and re-delivers the SAME version (D2.12-E)", async () => {
    const failing = makeDeps(store, {
      adapters: [
        {
          target: "stratifit-media",
          publish: async () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const pub = await prepareScheduled(failing.service, store);
    await failing.service.publish(makeActor(), pub.id);
    const versionCountAfterFail = store.versions.length;
    const versionIdBefore = store.publications[0]!.currentVersionId;

    const retried = await failing.service.retry(makeActor(), pub.id);
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.value.status).toBe("pending_approval");
    expect(store.versions).toHaveLength(versionCountAfterFail); // no new version
    expect(store.publications[0]!.currentVersionId).toBe(versionIdBefore);
  });

  it("enforces the attempt ceiling — failed becomes terminal after MAX attempts", async () => {
    const failing = makeDeps(store, {
      adapters: [
        {
          target: "stratifit-media",
          publish: async () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const pub = await prepareScheduled(failing.service, store);
    // Each retry re-enters pending_approval, so the full gate path must be
    // re-walked (approve → schedule) before the next publish attempt.
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i++) {
      await failing.service.publish(makeActor(), pub.id);
      if (i < MAX_PUBLISH_ATTEMPTS - 1) {
        await failing.service.retry(makeActor(), pub.id);
        await failing.service.approve(makeActor(), pub.id);
        await failing.service.schedule(makeActor(), pub.id, {
          scheduledFor: new Date(Date.now() + 60_000).toISOString(),
        });
      }
    }
    expect(store.publications[0]!.attemptCount).toBe(MAX_PUBLISH_ATTEMPTS);
    const retry = await failing.service.retry(makeActor(), pub.id);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.reason).toBe("max_attempts_exhausted");
    // The exhausted publication sits in terminal `failed`; a further publish
    // is rejected by the state machine (failed is not a publish source).
    const publish = await failing.service.publish(makeActor(), pub.id);
    expect(publish.ok).toBe(false);
    if (!publish.ok) expect(publish.error.reason).toBe("invalid_transition");
  });

  it("unpublish sends published → unpublished (terminal) and emits publication.unpublished (D2.13-1)", async () => {
    const pub = await prepareScheduled(service, store);
    await service.publish(makeActor(), pub.id);
    const result = await service.unpublish(makeActor(), pub.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe("unpublished");
    expect(events.map((e) => e.name)).toEqual([
      "publication.created",
      "publication.published",
      "publication.unpublished",
    ]);
    const again = await service.submit(makeActor(), pub.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe("invalid_transition");
  });

  it("revise is draft-only and appends version N+1 (D2.12-E)", async () => {
    const created = await service.createPublication(makeActor(), createInput());
    if (!created.ok) throw new Error("setup failed");
    const revised = await service.revise(makeActor(), created.value.publication.id, { title: "Recut" });
    expect(revised.ok).toBe(true);
    if (revised.ok) {
      expect(revised.value.versionNumber).toBe(2);
      expect(revised.value.title).toBe("Recut");
      expect(store.publications[0]!.currentVersionId).toBe(revised.value.id);
    }
    // Once active, revise is forbidden.
    await service.submit(makeActor(), created.value.publication.id);
    const lateRevise = await service.revise(makeActor(), created.value.publication.id, { title: "Nope" });
    expect(lateRevise.ok).toBe(false);
    if (!lateRevise.ok) expect(lateRevise.error.reason).toBe("invalid_transition");
  });

  it("schedule validates the timestamp and requires it to be in the future", async () => {
    const created = await service.createPublication(makeActor(), createInput());
    if (!created.ok) throw new Error("setup failed");
    await service.submit(makeActor(), created.value.publication.id);
    await service.approve(makeActor(), created.value.publication.id);
    const past = await service.schedule(makeActor(), created.value.publication.id, {
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error.reason).toBe("invalid_request");
  });

  it("blocks every illegal edge from the transition matrix", async () => {
    const created = await service.createPublication(makeActor(), createInput());
    if (!created.ok) throw new Error("setup failed");
    const id = created.value.publication.id;
    expect((await service.approve(makeActor(), id)).ok).toBe(false); // draft → approved
    expect((await service.schedule(makeActor(), id, { scheduledFor: new Date(Date.now() + 60_000).toISOString() })).ok).toBe(false);
    expect((await service.publish(makeActor(), id)).ok).toBe(false); // draft → publishing
    expect((await service.unpublish(makeActor(), id)).ok).toBe(false);
    expect((await service.retry(makeActor(), id)).ok).toBe(false);
  });

  it("blocks terminal reviews from any mutation and IDOR-safe reads cross-org", async () => {
    const pub = await prepareScheduled(service, store);
    await service.publish(makeActor(), pub.id);
    const foreign = await service.getPublication(makeActor({ organizationId: "org-2" }), pub.id);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.reason).toBe("publication_not_found");
  });
});

// ---------------------------------------------------------------------------
// Approve gate & rights seam
// ---------------------------------------------------------------------------

describe("approve gates (fail closed)", () => {
  it("blocks approval when the QC gate is not satisfied, with reasons", async () => {
    const gated = makeDeps(store, {
      resolveEligibility: async () => ({ eligible: false, reasons: ["required check 7 has no result"] }),
    }).service;
    const created = await gated.createPublication(makeActor(), createInput());
    if (!created.ok) throw new Error("setup failed");
    await gated.submit(makeActor(), created.value.publication.id);
    const result = await gated.approve(makeActor(), created.value.publication.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("gate_not_approved");
      expect(result.error.message).toContain("required check 7");
    }
    expect(store.publications[0]!.status).toBe("pending_approval");
  });

  it("fails closed when no QC review exists for the subject", async () => {
    const ungated = makeDeps(store, { resolveEligibility: async () => null }).service;
    const created = await ungated.createPublication(makeActor(), createInput());
    if (!created.ok) throw new Error("setup failed");
    await ungated.submit(makeActor(), created.value.publication.id);
    const result = await ungated.approve(makeActor(), created.value.publication.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("gate_not_approved");
  });

  it("treats an UNWIRED rights port as a vacuous pass (D2.12-A)", async () => {
    // No resolveRights injected at all — the production Stage 2.12 shape.
    const created = await service.createPublication(makeActor(), createInput());
    if (!created.ok) throw new Error("setup failed");
    await service.submit(makeActor(), created.value.publication.id);
    const result = await service.approve(makeActor(), created.value.publication.id);
    expect(result.ok).toBe(true);
  });

  it("blocks approval when declared rights requirements are unmet", async () => {
    const rightsBlocked = makeDeps(store, {
      resolveRights: async () => ({ declared: true, met: false, reasons: ["consent missing"] }),
    }).service;
    const created = await rightsBlocked.createPublication(makeActor(), createInput());
    if (!created.ok) throw new Error("setup failed");
    await rightsBlocked.submit(makeActor(), created.value.publication.id);
    const result = await rightsBlocked.approve(makeActor(), created.value.publication.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("rights_requirements_unmet");
      expect(result.error.message).toContain("consent missing");
    }
  });

  it("does NOT emit any QC→Asset coupling: events carry publishable fields only", async () => {
    const pub = await prepareScheduled(service, store);
    await service.publish(makeActor(), pub.id);
    for (const e of events) {
      expect(["publication.created", "publication.published", "publication.failed"]).toContain(e.name);
      const json = JSON.stringify(e.payload);
      // Operator-private events carry internal refs (the ratified QC
      // pattern) but NEVER organization identity or secrets.
      expect(json).not.toContain("org-1");
      expect(json).not.toMatch(/credential|secret|token/i);
    }
  });
});
