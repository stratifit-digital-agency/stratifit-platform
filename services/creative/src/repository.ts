/**
 * Drizzle repository adapter for the CREATIVE hierarchy (Stage 2.20).
 * Implements the CreativeRepository port from types.ts, mirroring the
 * services/people adapter conventions:
 *
 *  - `Database` (postgres.js via Drizzle) typed pool shared from the
 *    composition root (or built from a URL);
 *  - `mutationsFor` returns the SAME mutation shapes over either the shared
 *    pool or an open transaction connection; `appendAudit` REQUIRES the
 *    injected auditWriter (D2.4-1 seam) so a mutation and its audit record
 *    commit atomically — a rollback removes both;
 *  - runInTransaction exposes the SAME transaction connection to the domain
 *    mutations and the audit writer;
 *  - NO delete paths and NO content-update paths exist: rows are created and
 *    moved through the D2.20-6 lifecycle status transitions only (the
 *    production_id anchors are creation-only; D2.20 frozen scope).
 */
import { and, desc, eq } from "drizzle-orm";
import {
  createDatabase,
  episodes,
  productions,
  scenes,
  seasons,
  shots,
  stories,
  universes,
  worlds,
  type Database,
} from "@stratifit/database";
import type {
  ChainStatus,
  CreativeAuditWriter,
  CreativeRepository,
  CreativeTransaction,
  CreativeStoryKind,
  EpisodeRecord,
  SceneRecord,
  SeasonRecord,
  ShotRecord,
  StoryRecord,
  StoryStatus,
  UniverseRecord,
  WorldRecord,
} from "./types";

const asChain = (v: string): ChainStatus => v as ChainStatus;
const asStory = (v: string): StoryStatus => v as StoryStatus;
const asKind = (v: string): CreativeStoryKind => v as CreativeStoryKind;

export interface DrizzleCreativeRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /** D2.4-1 seam: same-transaction audit writer (composition-root mapped). */
  auditWriter?: CreativeAuditWriter;
}

export const createDrizzleCreativeRepository = (deps: DrizzleCreativeRepositoryDeps): CreativeRepository => {
  const exec: Database = deps.db ?? createDatabase(deps.databaseUrl as string);

  // -----------------------------------------------------------------------
  // Mutation scope: direct (pool) or transactional. `mutationsFor` returns
  // the SAME function shapes over either the shared pool or an open
  // transaction connection, plus appendAudit which REQUIRES the audit
  // writer (mirror of the people adapter).
  // -----------------------------------------------------------------------
  const mutationsFor = (
    conn: Database,
  ): Omit<CreativeTransaction, "appendAudit"> & {
    appendAudit: (entry: Parameters<CreativeAuditWriter["appendWithin"]>[1]) => Promise<void>;
  } => {
    const appendAudit = (entry: Parameters<CreativeAuditWriter["appendWithin"]>[1]) => {
      if (!deps.auditWriter) {
        throw new Error("creative audit writer not configured; mutations are not available in read-only compositions");
      }
      return deps.auditWriter.appendWithin(conn, entry);
    };

    return {
      findUniverseById: async (id) => {
        const [row] = await conn.select().from(universes).where(eq(universes.id, id)).limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      findWorldById: async (id) => {
        const [row] = await conn.select().from(worlds).where(eq(worlds.id, id)).limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      findStoryById: async (id) => {
        const [row] = await conn.select().from(stories).where(eq(stories.id, id)).limit(1);
        return row ? { ...row, kind: asKind(row.kind), status: asStory(row.status) } : null;
      },
      findSeasonById: async (id) => {
        const [row] = await conn.select().from(seasons).where(eq(seasons.id, id)).limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      findEpisodeById: async (id) => {
        const [row] = await conn.select().from(episodes).where(eq(episodes.id, id)).limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      findSceneById: async (id) => {
        const [row] = await conn.select().from(scenes).where(eq(scenes.id, id)).limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      findShotById: async (id) => {
        const [row] = await conn.select().from(shots).where(eq(shots.id, id)).limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      findUniverseBySlug: async (orgId, slug) => {
        const [row] = await conn
          .select()
          .from(universes)
          .where(and(eq(universes.orgId, orgId), eq(universes.slug, slug)))
          .limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      findProductionRef: async (id) => {
        const [row] = await conn
          .select({ id: productions.id, orgId: productions.orgId, status: productions.status })
          .from(productions)
          .where(eq(productions.id, id))
          .limit(1);
        return row ?? null;
      },

      insertUniverse: async (input) => {
        const [row] = await conn
          .insert(universes)
          .values({
            orgId: input.orgId,
            name: input.name,
            slug: input.slug,
            description: input.description,
          })
          .returning();
        return { ...row!, status: asChain(row!.status) };
      },
      insertWorld: async (input) => {
        const [row] = await conn
          .insert(worlds)
          .values({
            orgId: input.orgId,
            universeId: input.universeId,
            name: input.name,
            description: input.description,
          })
          .returning();
        return { ...row!, status: asChain(row!.status) };
      },
      insertStory: async (input) => {
        const [row] = await conn
          .insert(stories)
          .values({
            orgId: input.orgId,
            worldId: input.worldId,
            universeId: input.universeId,
            title: input.title,
            logline: input.logline,
            kind: input.kind,
            version: input.version,
          })
          .returning();
        return { ...row!, kind: asKind(row!.kind), status: asStory(row!.status) };
      },
      insertSeason: async (input) => {
        const [row] = await conn
          .insert(seasons)
          .values({
            orgId: input.orgId,
            storyId: input.storyId,
            seasonNumber: input.seasonNumber,
            title: input.title,
          })
          .returning();
        return { ...row!, status: asChain(row!.status) };
      },
      insertEpisode: async (input) => {
        const [row] = await conn
          .insert(episodes)
          .values({
            orgId: input.orgId,
            seasonId: input.seasonId,
            storyId: input.storyId,
            productionId: input.productionId,
            episodeNumber: input.episodeNumber,
            title: input.title,
          })
          .returning();
        return { ...row!, status: asChain(row!.status) };
      },
      insertScene: async (input) => {
        const [row] = await conn
          .insert(scenes)
          .values({
            orgId: input.orgId,
            storyId: input.storyId,
            episodeId: input.episodeId,
            productionId: input.productionId,
            orderIndex: input.orderIndex,
            title: input.title,
            synopsis: input.synopsis,
          })
          .returning();
        return { ...row!, status: asChain(row!.status) };
      },
      insertShot: async (input) => {
        const [row] = await conn
          .insert(shots)
          .values({
            orgId: input.orgId,
            sceneId: input.sceneId,
            orderIndex: input.orderIndex,
            description: input.description,
            aspect: input.aspect,
            durationSeconds: input.durationSeconds,
            fps: input.fps,
          })
          .returning();
        return { ...row!, status: asChain(row!.status) };
      },

      setUniverseStatus: async (id, status) => {
        const [row] = await conn
          .update(universes)
          .set({ status, updatedAt: new Date() })
          .where(eq(universes.id, id))
          .returning();
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      setWorldStatus: async (id, status) => {
        const [row] = await conn
          .update(worlds)
          .set({ status, updatedAt: new Date() })
          .where(eq(worlds.id, id))
          .returning();
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      setStoryStatus: async (id, status) => {
        const [row] = await conn
          .update(stories)
          .set({ status, updatedAt: new Date() })
          .where(eq(stories.id, id))
          .returning();
        return row ? { ...row, kind: asKind(row.kind), status: asStory(row.status) } : null;
      },
      setSeasonStatus: async (id, status) => {
        const [row] = await conn
          .update(seasons)
          .set({ status, updatedAt: new Date() })
          .where(eq(seasons.id, id))
          .returning();
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      setEpisodeStatus: async (id, status) => {
        const [row] = await conn
          .update(episodes)
          .set({ status, updatedAt: new Date() })
          .where(eq(episodes.id, id))
          .returning();
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      setSceneStatus: async (id, status) => {
        const [row] = await conn
          .update(scenes)
          .set({ status, updatedAt: new Date() })
          .where(eq(scenes.id, id))
          .returning();
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      setShotStatus: async (id, status) => {
        const [row] = await conn
          .update(shots)
          .set({ status, updatedAt: new Date() })
          .where(eq(shots.id, id))
          .returning();
        return row ? { ...row, status: asChain(row.status) } : null;
      },

      appendAudit,
    };
  };

  const direct = mutationsFor(exec);

  return {
    // Transaction-scoped mutations (D2.4-1): the service always uses this so
    // a mutation can never commit without its audit row.
    runInTransaction: async <T>(work: (tx: CreativeTransaction) => Promise<T>): Promise<T> =>
      exec.transaction(async (trx) => work(mutationsFor(trx as unknown as Database))),

    // -----------------------------------------------------------------
    // Reads (pool-level, no audit)
    // -----------------------------------------------------------------
    findUniverseById: direct.findUniverseById,
    listUniverses: (orgId, limit) =>
      exec
        .select()
        .from(universes)
        .where(eq(universes.orgId, orgId))
        .orderBy(desc(universes.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asChain(r.status) }))),
    findWorldById: direct.findWorldById,
    listWorlds: (orgId, limit) =>
      exec
        .select()
        .from(worlds)
        .where(eq(worlds.orgId, orgId))
        .orderBy(desc(worlds.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asChain(r.status) }))),
    findStoryById: direct.findStoryById,
    listStories: (orgId, limit) =>
      exec
        .select()
        .from(stories)
        .where(eq(stories.orgId, orgId))
        .orderBy(desc(stories.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, kind: asKind(r.kind), status: asStory(r.status) }))),
    findSeasonById: direct.findSeasonById,
    listSeasons: (orgId, limit) =>
      exec
        .select()
        .from(seasons)
        .where(eq(seasons.orgId, orgId))
        .orderBy(desc(seasons.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asChain(r.status) }))),
    findEpisodeById: direct.findEpisodeById,
    listEpisodes: (orgId, limit) =>
      exec
        .select()
        .from(episodes)
        .where(eq(episodes.orgId, orgId))
        .orderBy(desc(episodes.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asChain(r.status) }))),
    findSceneById: direct.findSceneById,
    listScenes: (orgId, limit) =>
      exec
        .select()
        .from(scenes)
        .where(eq(scenes.orgId, orgId))
        .orderBy(desc(scenes.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asChain(r.status) }))),
    findShotById: direct.findShotById,
    listShots: (orgId, limit) =>
      exec
        .select()
        .from(shots)
        .where(eq(shots.orgId, orgId))
        .orderBy(desc(shots.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asChain(r.status) }))),
    findUniverseBySlug: direct.findUniverseBySlug,

    // -----------------------------------------------------------------
    // Direct mutations (test-only sequential fallback) — the service always
    // prefers runInTransaction for audited mutations.
    // -----------------------------------------------------------------
    insertUniverse: direct.insertUniverse,
    insertWorld: direct.insertWorld,
    insertStory: direct.insertStory,
    insertSeason: direct.insertSeason,
    insertEpisode: direct.insertEpisode,
    insertScene: direct.insertScene,
    insertShot: direct.insertShot,
    setUniverseStatus: direct.setUniverseStatus,
    setWorldStatus: direct.setWorldStatus,
    setStoryStatus: direct.setStoryStatus,
    setSeasonStatus: direct.setSeasonStatus,
    setEpisodeStatus: direct.setEpisodeStatus,
    setSceneStatus: direct.setSceneStatus,
    setShotStatus: direct.setShotStatus,
  };
};
