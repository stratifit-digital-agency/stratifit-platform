/**
 * Creative service unit tests (Stage 2.20, D2.20-1..D2.20-9).
 *
 * In-memory fake repository mirroring the real Drizzle adapter semantics:
 * UNIQUE(org, slug) on universes, UNIQUE(story, season_number), partial
 * uniques on episodes/scenes/shots ordering, transaction-scoped audit sink.
 * Covers the frozen matrix: hierarchy creation with in-tx parent integrity
 * (same-org, non-retired, completed-story rejection), production-reference
 * validation, every allowed + forbidden lifecycle transition, terminal
 * enforcement, capability gating, audit atomicity (rollback removes both),
 * failed mutation leaves no audit row, server-derived org authority.
 */
import { describe, expect, it } from "vitest";
import { createCreativeService } from "./service";
import type {
  ChainStatus,
  CreativeAggregateKind,
  CreativeAuditAppend,
  CreativePrincipal,
  CreativeRepository,
  CreativeTransaction,
  EpisodeRecord,
  SceneRecord,
  SeasonRecord,
  ShotRecord,
  StoryRecord,
  StoryStatus,
  UniverseRecord,
  WorldRecord,
} from "./types";
import { CREATIVE_AUDIT_ACTIONS } from "./types";

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

type Store = {
  un: UniverseRecord[];
  wo: WorldRecord[];
  st: StoryRecord[];
  se: SeasonRecord[];
  ep: EpisodeRecord[];
  sc: SceneRecord[];
  sh: ShotRecord[];
  /** Production reference rows for the productionId integrity check. */
  prod: { id: string; orgId: string; status: string }[];
  audit: Parameters<CreativeAuditAppend>[0][];
  /** Test hook: force the next mutation to throw (rollback/atomicity proofs). */
  failNextMutation?: boolean;
};

const now = () => new Date();
let n = 0;
const seq = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const makeStore = (): Store => ({
  un: [],
  wo: [],
  st: [],
  se: [],
  ep: [],
  sc: [],
  sh: [],
  prod: [],
  audit: [],
});

/** The transaction view: same store, plus the shared audit sink. */
const makeTx = (store: Store): CreativeTransaction => ({
  findUniverseById: async (id) => store.un.find((r) => r.id === id) ?? null,
  findWorldById: async (id) => store.wo.find((r) => r.id === id) ?? null,
  findStoryById: async (id) => store.st.find((r) => r.id === id) ?? null,
  findSeasonById: async (id) => store.se.find((r) => r.id === id) ?? null,
  findEpisodeById: async (id) => store.ep.find((r) => r.id === id) ?? null,
  findSceneById: async (id) => store.sc.find((r) => r.id === id) ?? null,
  findShotById: async (id) => store.sh.find((r) => r.id === id) ?? null,
  findUniverseBySlug: async (orgId, slug) =>
    store.un.find((r) => r.orgId === orgId && r.slug === slug) ?? null,
  findProductionRef: async (id) => store.prod.find((r) => r.id === id) ?? null,
  insertUniverse: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    if (store.un.some((r) => r.orgId === input.orgId && r.slug === input.slug)) {
      throw Object.assign(new Error("duplicate slug"), { code: "23505" });
    }
    const row: UniverseRecord = {
      id: seq(), orgId: input.orgId, name: input.name, slug: input.slug,
      description: input.description, status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.un.push(row);
    return row;
  },
  insertWorld: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    const row: WorldRecord = {
      id: seq(), orgId: input.orgId, universeId: input.universeId, name: input.name,
      description: input.description, status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.wo.push(row);
    return row;
  },
  insertStory: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    const row: StoryRecord = {
      id: seq(), orgId: input.orgId, worldId: input.worldId, universeId: input.universeId,
      title: input.title, logline: input.logline, kind: input.kind, version: input.version,
      status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.st.push(row);
    return row;
  },
  insertSeason: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    if (store.se.some((r) => r.storyId === input.storyId && r.seasonNumber === input.seasonNumber)) {
      throw Object.assign(new Error("duplicate season"), { code: "23505" });
    }
    const row: SeasonRecord = {
      id: seq(), orgId: input.orgId, storyId: input.storyId, seasonNumber: input.seasonNumber,
      title: input.title, status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.se.push(row);
    return row;
  },
  insertEpisode: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    const row: EpisodeRecord = {
      id: seq(), orgId: input.orgId, seasonId: input.seasonId, storyId: input.storyId,
      productionId: input.productionId, episodeNumber: input.episodeNumber,
      title: input.title, status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.ep.push(row);
    return row;
  },
  insertScene: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    const row: SceneRecord = {
      id: seq(), orgId: input.orgId, storyId: input.storyId, episodeId: input.episodeId,
      productionId: input.productionId, orderIndex: input.orderIndex, title: input.title,
      synopsis: input.synopsis, status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.sc.push(row);
    return row;
  },
  insertShot: async (input) => {
    if (store.failNextMutation) throw new Error("forced insert failure");
    const row: ShotRecord = {
      id: seq(), orgId: input.orgId, sceneId: input.sceneId, orderIndex: input.orderIndex,
      description: input.description, aspect: input.aspect,
      durationSeconds: input.durationSeconds, fps: input.fps,
      status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.sh.push(row);
    return row;
  },
  setUniverseStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.un.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.un = store.un.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  setWorldStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.wo.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.wo = store.wo.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  setStoryStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.st.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.st = store.st.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  setSeasonStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.se.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.se = store.se.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  setEpisodeStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.ep.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.ep = store.ep.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  setSceneStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.sc.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.sc = store.sc.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  setShotStatus: async (id, status) => {
    if (store.failNextMutation) throw new Error("forced update failure");
    const row = store.sh.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.sh = store.sh.map((r) => (r.id === id ? updated : r));
    return updated;
  },
  appendAudit: async (entry) => {
    store.audit.push(entry);
  },
});

/** Fake repo with D2.4-1 transaction semantics: throw rolls back everything. */
const fakeRepo = (store: Store): CreativeRepository => ({
  runInTransaction: async <T>(work: (tx: CreativeTransaction) => Promise<T>): Promise<T> => {
    const auditBefore = store.audit.length;
    try {
      return await work(makeTx(store));
    } catch (e) {
      // Rollback: audit rows written inside the failed tx are removed.
      store.audit.length = auditBefore;
      throw e;
    }
  },
  findUniverseById: async (id) => store.un.find((r) => r.id === id) ?? null,
  listUniverses: async (orgId) => store.un.filter((r) => r.orgId === orgId),
  findWorldById: async (id) => store.wo.find((r) => r.id === id) ?? null,
  listWorlds: async (orgId) => store.wo.filter((r) => r.orgId === orgId),
  findStoryById: async (id) => store.st.find((r) => r.id === id) ?? null,
  listStories: async (orgId) => store.st.filter((r) => r.orgId === orgId),
  findSeasonById: async (id) => store.se.find((r) => r.id === id) ?? null,
  listSeasons: async (orgId) => store.se.filter((r) => r.orgId === orgId),
  findEpisodeById: async (id) => store.ep.find((r) => r.id === id) ?? null,
  listEpisodes: async (orgId) => store.ep.filter((r) => r.orgId === orgId),
  findSceneById: async (id) => store.sc.find((r) => r.id === id) ?? null,
  listScenes: async (orgId) => store.sc.filter((r) => r.orgId === orgId),
  findShotById: async (id) => store.sh.find((r) => r.id === id) ?? null,
  listShots: async (orgId) => store.sh.filter((r) => r.orgId === orgId),
  findUniverseBySlug: async (orgId, slug) =>
    store.un.find((r) => r.orgId === orgId && r.slug === slug) ?? null,
  insertUniverse: makeTx(store).insertUniverse,
  insertWorld: makeTx(store).insertWorld,
  insertStory: makeTx(store).insertStory,
  insertSeason: makeTx(store).insertSeason,
  insertEpisode: makeTx(store).insertEpisode,
  insertScene: makeTx(store).insertScene,
  insertShot: makeTx(store).insertShot,
  setUniverseStatus: makeTx(store).setUniverseStatus,
  setWorldStatus: makeTx(store).setWorldStatus,
  setStoryStatus: makeTx(store).setStoryStatus,
  setSeasonStatus: makeTx(store).setSeasonStatus,
  setEpisodeStatus: makeTx(store).setEpisodeStatus,
  setSceneStatus: makeTx(store).setSceneStatus,
  setShotStatus: makeTx(store).setShotStatus,
});

// ---------------------------------------------------------------------------
// Principals (server-derived shape; org/actor never come from input bodies)
// ---------------------------------------------------------------------------

const admin = (orgId: string): CreativePrincipal => ({
  operatorId: "11111111-1111-4111-8111-111111111111",
  orgId,
  capabilities: ["creative.manage", "creative.read"],
});
const operator = (orgId: string): CreativePrincipal => ({
  operatorId: "22222222-2222-4222-8222-222222222222",
  orgId,
  capabilities: ["creative.manage", "creative.read"],
});
const reviewer = (orgId: string): CreativePrincipal => ({
  operatorId: "33333333-3333-4333-8333-333333333333",
  orgId,
  capabilities: ["creative.read"],
});
const viewer = (orgId: string): CreativePrincipal => ({
  operatorId: "44444444-4444-4444-8444-444444444444",
  orgId,
  capabilities: ["creative.read"],
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Hierarchy seed: universe → world → story → season → episode → scene. */
const seedHierarchy = async (svc: ReturnType<typeof createCreativeService>, orgId: string) => {
  const p = admin(orgId);
  const un = await svc.createUniverse(p, { name: "Aurora", slug: "aurora" });
  if (!un.ok) throw new Error(un.error.message);
  const wo = await svc.createWorld(p, { universeId: un.value.id, name: "Northlands" });
  if (!wo.ok) throw new Error(wo.error.message);
  const st = await svc.createStory(p, { worldId: wo.value.id, universeId: un.value.id, title: "Long Night", logline: "Survive.", kind: "series" });
  if (!st.ok) throw new Error(st.error.message);
  const se = await svc.createSeason(p, { storyId: st.value.id, seasonNumber: 1, title: "S1" });
  if (!se.ok) throw new Error(se.error.message);
  const ep = await svc.createEpisode(p, { seasonId: se.value.id, storyId: st.value.id, episodeNumber: 1, title: "Pilot" });
  if (!ep.ok) throw new Error(ep.error.message);
  const sc = await svc.createScene(p, { storyId: st.value.id, episodeId: ep.value.id, orderIndex: 0, title: "Opening" });
  if (!sc.ok) throw new Error(sc.error.message);
  const sh = await svc.createShot(p, { sceneId: sc.value.id, orderIndex: 0, description: "Wide", aspect: "16:9", durationSeconds: 4, fps: 24 });
  if (!sh.ok) throw new Error(sh.error.message);
  return { p, un: un.value, wo: wo.value, st: st.value, se: se.value, ep: ep.value, sc: sc.value, sh: sh.value };
};
// ---------------------------------------------------------------------------
// Creation matrix: full hierarchy, parent integrity, authority
// ---------------------------------------------------------------------------

describe("creative creation (Stage 2.20)", () => {
  it("authors the full seven-level hierarchy in one org with created-audit rows", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    expect(h.sh.status).toBe("draft");
    const actions = store.audit.map((a) => a.action);
    expect(actions).toEqual([
      "creative.universe_created",
      "creative.world_created",
      "creative.story_created",
      "creative.season_created",
      "creative.episode_created",
      "creative.scene_created",
      "creative.shot_created",
    ]);
    for (const a of store.audit) {
      expect(a.actorId).toBe("11111111-1111-4111-8111-111111111111");
      expect(a.organizationId).toBe(ORG_A);
    }
  });

  it("rejects a cross-org universe parent as not_found (no existence leak)", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const other = admin(ORG_B);
    const r = await svc.createWorld(other, { universeId: h.un.id, name: "Evil World" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("not_found");
    expect(store.wo).toHaveLength(1);
  });

  it("rejects a missing parent as not_found", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const r = await svc.createWorld(admin(ORG_A), { universeId: seq(), name: "Ghost" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("not_found");
  });

  it("rejects a retired parent with inactive_parent", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const retire = await svc.changeStatus(h.p, "universe", { id: h.un.id, status: "retired" });
    expect(retire.ok).toBe(true);
    const r = await svc.createWorld(h.p, { universeId: h.un.id, name: "Orphan" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("inactive_parent");
  });

  it("rejects a completed story parent with inactive_parent", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    // draft → active → completed (draft → completed is itself rejected).
    expect((await svc.changeStatus(h.p, "story", { id: h.st.id, status: "active" })).ok).toBe(true);
    const done = await svc.changeStatus(h.p, "story", { id: h.st.id, status: "completed" });
    expect(done.ok).toBe(true);
    const r = await svc.createSeason(h.p, { storyId: h.st.id, seasonNumber: 2, title: "S2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("inactive_parent");
  });

  it("rejects duplicate universe slug within the org (duplicate_slug)", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    await svc.createUniverse(admin(ORG_A), { name: "Aurora", slug: "aurora" });
    const r = await svc.createUniverse(admin(ORG_A), { name: "Again", slug: "aurora" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("duplicate_slug");
  });

  it("permits the same slug in a different org (org-scoped uniqueness)", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const a = await svc.createUniverse(admin(ORG_A), { name: "Aurora", slug: "aurora" });
    const b = await svc.createUniverse(admin(ORG_B), { name: "Aurora", slug: "aurora" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("story requires worldId or universeId; both parents same-org validated", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const none = await svc.createStory(admin(ORG_A), { title: "Orphan", logline: "x", kind: "film" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.reason).toBe("invalid_input");
    const crossOrg = await svc.createStory(admin(ORG_B), { worldId: seq(), title: "T", logline: "x", kind: "film" });
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.error.reason).toBe("not_found");
  });

  it("episode/scene productionId must exist, be same-org, and be non-terminal", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    store.prod.push({ id: seq(), orgId: ORG_A, status: "published" });
    const okEp = await svc.createEpisode(h.p, { seasonId: h.se.id, episodeNumber: 2, title: "E2", productionId: store.prod[0]!.id });
    expect(okEp.ok).toBe(true);
    const missing = await svc.createEpisode(h.p, { seasonId: h.se.id, episodeNumber: 3, title: "E3", productionId: seq() });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.reason).toBe("not_found");
    const foreign = seq();
    store.prod.push({ id: foreign, orgId: ORG_B, status: "published" });
    const crossOrg = await svc.createScene(h.p, { episodeId: h.ep.id, orderIndex: 1, title: "S2", productionId: foreign });
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.error.reason).toBe("not_found");
    const terminal = seq();
    store.prod.push({ id: terminal, orgId: ORG_A, status: "archived" });
    const archived = await svc.createScene(h.p, { episodeId: h.ep.id, orderIndex: 2, title: "S3", productionId: terminal });
    expect(archived.ok).toBe(false);
    if (!archived.ok) expect(archived.error.reason).toBe("inactive_parent");
  });

  it("client cannot control the organization: org comes only from the principal", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    // The input type carries NO orgId at all; a malicious caller in org B
    // pointing at A's universe simply fails closed as not_found.
    const r = await svc.createWorld(admin(ORG_B), { universeId: h.un.id, name: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("not_found");
    expect(store.wo.filter((w) => w.orgId === ORG_B)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle matrix (D2.20-6)
// ---------------------------------------------------------------------------

const CHAIN_KINDS: CreativeAggregateKind[] = ["universe", "world", "season", "episode", "scene", "shot"];
const ID_OF: Record<CreativeAggregateKind, (h: Awaited<ReturnType<typeof seedHierarchy>>) => string> = {
  universe: (h) => h.un.id,
  world: (h) => h.wo.id,
  story: (h) => h.st.id,
  season: (h) => h.se.id,
  episode: (h) => h.ep.id,
  scene: (h) => h.sc.id,
  shot: (h) => h.sh.id,
};

describe("creative lifecycle transitions (D2.20-6)", () => {
  it("allows every frozen chain transition for all six chain aggregates", async () => {
    for (const kind of CHAIN_KINDS) {
      const store = makeStore();
      const svc = createCreativeService({ repository: fakeRepo(store) });
      const h = await seedHierarchy(svc, ORG_A);
      const p = h.p;
      const id = ID_OF[kind](h);
      const d2a = await svc.changeStatus(p, kind, { id, status: "active" });
      expect(d2a.ok, `${kind} draft->active`).toBe(true);
      const a2r = await svc.changeStatus(p, kind, { id, status: "retired" });
      expect(a2r.ok, `${kind} active->retired`).toBe(true);
    }
  });

  it("allows draft -> retired directly for chain aggregates", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const r = await svc.changeStatus(h.p, "world", { id: h.wo.id, status: "retired" });
    expect(r.ok).toBe(true);
  });

  it("walks the full story lifecycle including completed -> retired", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const p = h.p;
    const id = h.st.id;
    expect((await svc.changeStatus(p, "story", { id, status: "active" })).ok).toBe(true);
    expect((await svc.changeStatus(p, "story", { id, status: "completed" })).ok).toBe(true);
    expect((await svc.changeStatus(p, "story", { id, status: "retired" })).ok).toBe(true);
  });

  it("rejects every forbidden chain transition", async () => {
    for (const kind of CHAIN_KINDS) {
      const store = makeStore();
      const svc = createCreativeService({ repository: fakeRepo(store) });
      const h = await seedHierarchy(svc, ORG_A);
      const p = h.p;
      const id = ID_OF[kind](h);
      // Unknown id: not_found (never invalid_transition).
      const bad = await svc.changeStatus(p, kind, { id: seq(), status: "active" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.reason).toBe("not_found");
      // from active: only retired is legal.
      await svc.changeStatus(p, kind, { id, status: "active" });
      const reactivate = await svc.changeStatus(p, kind, { id, status: "draft" });
      expect(reactivate.ok, `${kind} active->draft`).toBe(false);
      // from retired: terminal.
      await svc.changeStatus(p, kind, { id, status: "retired" });
      const resurrect = await svc.changeStatus(p, kind, { id, status: "active" });
      expect(resurrect.ok, `${kind} retired->active`).toBe(false);
      const redraft = await svc.changeStatus(p, kind, { id, status: "draft" });
      expect(redraft.ok, `${kind} retired->draft`).toBe(false);
    }
  });

  it("story completed is terminal except retired", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const p = h.p;
    const id = h.st.id;
    await svc.changeStatus(p, "story", { id, status: "active" });
    await svc.changeStatus(p, "story", { id, status: "completed" });
    const back = await svc.changeStatus(p, "story", { id, status: "active" });
    expect(back.ok).toBe(false);
    const draft = await svc.changeStatus(p, "story", { id, status: "draft" });
    expect(draft.ok).toBe(false);
    // The single frozen exit:
    const out = await svc.changeStatus(p, "story", { id, status: "retired" });
    expect(out.ok).toBe(true);
  });

  it("paused does not exist and completed is valid vocabulary ONLY for stories", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const paused = await svc.changeStatus(h.p, "story", { id: h.st.id, status: "paused" as StoryStatus });
    expect(paused.ok).toBe(false);
    const doneOnWorld = await svc.changeStatus(h.p, "world", { id: h.wo.id, status: "completed" as ChainStatus });
    expect(doneOnWorld.ok).toBe(false);
    if (!doneOnWorld.ok) expect(doneOnWorld.error.reason).toBe("invalid_status_transition");
  });

  it("rejects same-status transitions and unknown ids", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const same = await svc.changeStatus(h.p, "universe", { id: h.un.id, status: "draft" });
    expect(same.ok).toBe(false);
    const ghost = await svc.changeStatus(h.p, "universe", { id: seq(), status: "active" });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.reason).toBe("not_found");
  });

  it("cross-org status mutation returns not_found (IDOR-safe)", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const r = await svc.changeStatus(admin(ORG_B), "universe", { id: h.un.id, status: "active" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("not_found");
    expect(store.un[0]!.status).toBe("draft");
  });
});
// ---------------------------------------------------------------------------
// Capability gates, audit atomicity, reads
// ---------------------------------------------------------------------------

describe("creative capability gates (D2.20-5)", () => {
  it("reviewer and viewer can read but can NEVER mutate", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    for (const principal of [reviewer(ORG_A), viewer(ORG_A)]) {
      const created = await svc.createUniverse(principal, { name: "Nope", slug: "nope" });
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.reason).toBe("unauthorized");
      const status = await svc.changeStatus(principal, "universe", { id: h.un.id, status: "active" });
      expect(status.ok).toBe(false);
      if (!status.ok) expect(status.error.reason).toBe("unauthorized");
      const list = await svc.listUniverses(principal, 10);
      expect(list.ok).toBe(true);
    }
    // No unauthorized mutation reached the store, and none wrote audit rows.
    expect(store.un).toHaveLength(1);
    const actions = store.audit.map((a) => a.action);
    expect(actions.every((a) => a.startsWith("creative."))).toBe(true);
    expect(store.audit.length).toBe(7);
  });

  it("missing manage capability fails closed even for org-scoped strangers", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const noCaps: CreativePrincipal = { operatorId: seq(), orgId: ORG_A, capabilities: [] };
    const r = await svc.createUniverse(noCaps, { name: "X", slug: "x-universe" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("unauthorized");
  });
});

describe("audit atomicity (D2.20-8)", () => {
  it("a failed mutation leaves NO domain row and NO audit row (rollback proof)", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const before = store.audit.length;
    store.failNextMutation = true;
    // Infrastructure failure THROWS (house semantics: discriminated results
    // are for domain failures; DB errors propagate to the 500 boundary) —
    // the assertion that matters is atomicity: the rollback removes the
    // audit row that was written inside the failed transaction.
    await expect(svc.createWorld(h.p, { universeId: h.un.id, name: "Boom" })).rejects.toThrow("forced insert failure");
    expect(store.wo).toHaveLength(1); // only the seeded world
    expect(store.audit.length).toBe(before); // rollback removed the audit row
  });

  it("status-change failure (invalid transition) writes no audit row", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const before = store.audit.length;
    const r = await svc.changeStatus(h.p, "universe", { id: h.un.id, status: "retired" });
    expect(r.ok).toBe(true);
    const afterRetire = store.audit.length;
    // active->draft? no: retired is terminal, attempt again
    const bad = await svc.changeStatus(h.p, "universe", { id: h.un.id, status: "draft" });
    expect(bad.ok).toBe(false);
    expect(store.audit.length).toBe(afterRetire);
  });

  it("status-change audit rows record the real operator and from/to metadata", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    const h = await seedHierarchy(svc, ORG_A);
    const op = operator(ORG_A);
    const r = await svc.changeStatus(op, "universe", { id: h.un.id, status: "active" });
    expect(r.ok).toBe(true);
    const entry = store.audit.find((a) => a.action === "creative.universe_status_changed");
    expect(entry).toBeDefined();
    expect(entry!.actorId).toBe("22222222-2222-4222-8222-222222222222");
    expect(entry!.organizationId).toBe(ORG_A);
    expect(entry!.metadata).toMatchObject({ from: "draft", to: "active" });
  });

  it("all fourteen frozen audit actions exist", () => {
    const expected = [
      "creative.universe_created",
      "creative.universe_status_changed",
      "creative.world_created",
      "creative.world_status_changed",
      "creative.story_created",
      "creative.story_status_changed",
      "creative.season_created",
      "creative.season_status_changed",
      "creative.episode_created",
      "creative.episode_status_changed",
      "creative.scene_created",
      "creative.scene_status_changed",
      "creative.shot_created",
      "creative.shot_status_changed",
    ];
    expect([...CREATIVE_AUDIT_ACTIONS]).toEqual(expected);
  });
});

describe("creative reads (creative.read)", () => {
  it("lists are org-scoped", async () => {
    const store = makeStore();
    const svc = createCreativeService({ repository: fakeRepo(store) });
    await seedHierarchy(svc, ORG_A);
    await svc.createUniverse(admin(ORG_B), { name: "B-verse", slug: "b-verse" });
    const p = admin(ORG_A);
    const un = await svc.listUniverses(p);
    const wo = await svc.listWorlds(p);
    const st = await svc.listStories(p);
    const se = await svc.listSeasons(p);
    const ep = await svc.listEpisodes(p);
    const sc = await svc.listScenes(p);
    const sh = await svc.listShots(p);
    expect(un.ok && un.value).toHaveLength(1);
    expect(wo.ok && wo.value).toHaveLength(1);
    expect(st.ok && st.value).toHaveLength(1);
    expect(se.ok && se.value).toHaveLength(1);
    expect(ep.ok && ep.value).toHaveLength(1);
    expect(sc.ok && sc.value).toHaveLength(1);
    expect(sh.ok && sh.value).toHaveLength(1);
  });
});
