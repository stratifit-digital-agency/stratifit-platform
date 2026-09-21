/**
 * Creative / Story domain service (Stage 2.20, D2.20-1..D2.20-9).
 *
 * Seven-aggregate narrative hierarchy authoring. Every command:
 *  - derives authority from the server-derived Control principal
 *    (operatorId + orgId + capabilities resolved by identity — never a
 *    client body field);
 *  - gates via the creative.manage / creative.read capability family
 *    (D2.20-5 — never production.*);
 *  - validates EVERY parent relationship INSIDE the mutation transaction:
 *    existence, SAME-ORG ownership, and non-retired status (People chain-
 *    integrity precedent; cross-org fails closed as not_found — no
 *    existence disclosure);
 *  - writes the frozen audit action in the SAME transaction (D2.4-1/D2.20-8)
 *    so a rollback removes both the mutation and its audit row;
 *  - never throws for domain failures (discriminated results).
 *
 * D2.20-6 lifecycles are validated server-side via frozen transition
 * tables; retired is terminal everywhere and story `completed` exits only
 * to retired. No paused state exists in this context.
 */
import {
  CHAIN_STATUSES,
  CREATIVE_AUDIT_ACTIONS,
  CREATIVE_STORY_KINDS,
  SLUG_RE,
  STORY_STATUSES,
  err,
  ok,
} from "./types";
import type {
  ChainStatus,
  CreateEpisodeInput,
  CreateSceneInput,
  CreateSeasonInput,
  CreateShotInput,
  CreateStoryInput,
  CreateUniverseInput,
  CreateWorldInput,
  CreativeAggregateKind,
  CreativePrincipal,
  CreativeRepository,
  CreativeResult,
  CreativeService,
  CreativeServiceDeps,
  CreativeTransaction,
  CreativeStoryKind,
  EpisodeRecord,
  SceneRecord,
  SeasonRecord,
  ShotRecord,
  StatusChangeInput,
  StoryRecord,
  StoryStatus,
  UniverseRecord,
  WorldRecord,
} from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? 50, 1), 200);

/**
 * D2.20-6 transition tables (frozen):
 *  - chain aggregates: draft → active → retired (retired terminal);
 *  - stories: draft → active → completed → retired, where `completed` is
 *    terminal EXCEPT the frozen exit to retired; retired is terminal;
 *    no paused state exists; same-status and unknown pairs are invalid.
 */
const validChainTransition = (from: ChainStatus, to: ChainStatus): boolean =>
  (from === "draft" && to === "active") ||
  (from === "active" && to === "retired") ||
  (from === "draft" && to === "retired");

const validStoryTransition = (from: StoryStatus, to: StoryStatus): boolean =>
  (from === "draft" && to === "active") ||
  (from === "draft" && to === "retired") ||
  (from === "active" && to === "completed") ||
  (from === "active" && to === "retired") ||
  (from === "completed" && to === "retired");

/** Statuses allowed for a kind (stories carry the extended vocabulary). */
const statusesForKind = (kind: CreativeAggregateKind): readonly string[] =>
  kind === "story" ? STORY_STATUSES : CHAIN_STATUSES;

const manageGate = (principal: CreativePrincipal): CreativeResult<void> =>
  principal.capabilities.includes("creative.manage")
    ? ok(undefined)
    : err("unauthorized", "creative.manage capability required");

const readGate = (principal: CreativePrincipal): CreativeResult<void> =>
  principal.capabilities.includes("creative.read")
    ? ok(undefined)
    : err("unauthorized", "creative.read capability required");

const isStoryKind = (kind: CreativeAggregateKind): boolean => kind === "story";

/**
 * Parent-chain integrity (People precedent): the parent must exist, belong
 * to the caller's org, and not be retired. Cross-org reports not_found —
 * never confirm existence in another organization. Because this runs inside
 * the mutation transaction, no TOCTOU window exists between the check and
 * the child insert.
 */
const requireParent = async <T extends { id: string; orgId: string; status: string }>(
  tx: CreativeTransaction,
  kind: CreativeAggregateKind,
  parentId: string,
  expectedOrgId: string,
): Promise<CreativeResult<T>> => {
  const finders: Record<
    CreativeAggregateKind,
    (id: string) => Promise<T | null>
  > = {
    universe: tx.findUniverseById as unknown as (id: string) => Promise<T | null>,
    world: tx.findWorldById as unknown as (id: string) => Promise<T | null>,
    story: tx.findStoryById as unknown as (id: string) => Promise<T | null>,
    season: tx.findSeasonById as unknown as (id: string) => Promise<T | null>,
    episode: tx.findEpisodeById as unknown as (id: string) => Promise<T | null>,
    scene: tx.findSceneById as unknown as (id: string) => Promise<T | null>,
    // shots never parent anything, but the record keeps the map total.
    shot: (async () => null) as unknown as (id: string) => Promise<T | null>,
  };
  const parent = await finders[kind](parentId);
  if (!parent) return err("not_found", `${kind} parent does not exist`);
  if (parent.orgId !== expectedOrgId)
    return err("not_found", "referenced parent does not exist");
  if (parent.status === "retired") return err("inactive_parent", `${kind} parent is retired`);
  if ((parent.status as string) === "completed")
    return err("inactive_parent", "story parent is completed");
  return ok(parent);
};

/**
 * D2.4-1 (reused): every audited mutation runs inside ONE transaction so it
 * can never commit without its audit record. The repository port declares
 * runInTransaction as required (no audited path exists without it).
 */
const inTx = <T>(repo: CreativeRepository, work: (tx: CreativeTransaction) => Promise<T>): Promise<T> =>
  repo.runInTransaction(work);

export const createCreativeService = (deps: CreativeServiceDeps): CreativeService => {
  const repo = deps.repository;

  return {
    // -----------------------------------------------------------------------
    // Control authoring (creative.manage)
    // -----------------------------------------------------------------------
    async createUniverse(principal, input: CreateUniverseInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const name = input.name.trim();
      if (name.length < 1 || name.length > 200) return err("invalid_input", "name must be 1..200 characters");
      const slug = input.slug.trim();
      if (!SLUG_RE.test(slug)) return err("invalid_slug", "slug must match ^[a-z0-9-]{3,64}$");
      if (input.description != null && input.description.length > 4000)
        return err("invalid_input", "description must be at most 4000 characters");

      // Duplicate slug within the org fails closed BEFORE the insert
      // (UNIQUE(org, slug) backstops inside the transaction).
      const existing = await repo.findUniverseBySlug(principal.orgId, slug);
      if (existing) return err("duplicate_slug", "universe slug already exists in this organization");

      const row = await inTx(repo, async (tx) => {
        const created = await tx.insertUniverse({
          orgId: principal.orgId, // server-derived organization — never client-supplied
          name,
          slug,
          description: input.description ?? null,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: CREATIVE_AUDIT_ACTIONS[0],
          targetType: "universe",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { name, slug },
        });
        return created;
      });
      return ok(row);
    },

    async createWorld(principal, input: CreateWorldInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const name = input.name.trim();
      if (name.length < 1 || name.length > 200) return err("invalid_input", "name must be 1..200 characters");
      if (!UUID_RE.test(input.universeId)) return err("invalid_input", "universeId must be a valid uuid");
      if (input.description != null && input.description.length > 4000)
        return err("invalid_input", "description must be at most 4000 characters");

      const row = await inTx(repo, async (tx) => {
        // Parent integrity INSIDE the transaction (same-org, non-retired).
        const parent = await requireParent<UniverseRecord>(tx, "universe", input.universeId, principal.orgId);
        if (!parent.ok) return { tag: "error" as const, error: parent.error };
        const created = await tx.insertWorld({
          orgId: principal.orgId,
          universeId: parent.value.id,
          name,
          description: input.description ?? null,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: CREATIVE_AUDIT_ACTIONS[2],
          targetType: "world",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { name, universeId: parent.value.id },
        });
        return { tag: "ok" as const, row: created };
      });
      return outcomeOf(row);
    },

    async createStory(principal, input: CreateStoryInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const title = input.title.trim();
      if (title.length < 1 || title.length > 300) return err("invalid_input", "title must be 1..300 characters");
      const logline = input.logline.trim();
      if (logline.length < 1 || logline.length > 1000) return err("invalid_input", "logline must be 1..1000 characters");
      if (!(CREATIVE_STORY_KINDS as readonly string[]).includes(input.kind))
        return err("invalid_input", `kind must be one of ${CREATIVE_STORY_KINDS.join(", ")}`);
      const version = input.version ?? 1;
      if (!Number.isInteger(version) || version < 1) return err("invalid_input", "version must be a positive integer");

      // At least one hierarchy anchor: world OR universe (DM section 8).
      if (!input.worldId && !input.universeId)
        return err("invalid_input", "story requires worldId or universeId");

      const row = await inTx(repo, async (tx) => {
        let worldId: string | null = null;
        let universeId: string | null = null;
        if (input.worldId) {
          if (!UUID_RE.test(input.worldId)) return { tag: "error" as const, error: { reason: "invalid_input" as const, message: "worldId must be a valid uuid" } };
          const parent = await requireParent<WorldRecord>(tx, "world", input.worldId, principal.orgId);
          if (!parent.ok) return { tag: "error" as const, error: parent.error };
          worldId = parent.value.id;
        }
        if (input.universeId) {
          if (!UUID_RE.test(input.universeId)) return { tag: "error" as const, error: { reason: "invalid_input" as const, message: "universeId must be a valid uuid" } };
          const parent = await requireParent<UniverseRecord>(tx, "universe", input.universeId, principal.orgId);
          if (!parent.ok) return { tag: "error" as const, error: parent.error };
          universeId = parent.value.id;
        }
        const created = await tx.insertStory({
          orgId: principal.orgId,
          worldId,
          universeId,
          title,
          logline,
          kind: input.kind as CreativeStoryKind,
          version,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: CREATIVE_AUDIT_ACTIONS[4],
          targetType: "story",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { title, kind: input.kind, worldId, universeId, version },
        });
        return { tag: "ok" as const, row: created };
      });
      return outcomeOf(row);
    },

    async createSeason(principal, input: CreateSeasonInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const title = input.title.trim();
      if (title.length < 1 || title.length > 300) return err("invalid_input", "title must be 1..300 characters");
      if (!Number.isInteger(input.seasonNumber) || input.seasonNumber < 1)
        return err("invalid_input", "seasonNumber must be a positive integer");
      if (!UUID_RE.test(input.storyId)) return err("invalid_input", "storyId must be a valid uuid");

      const row = await inTx(repo, async (tx) => {
        const parent = await requireParent<StoryRecord>(tx, "story", input.storyId, principal.orgId);
        if (!parent.ok) return { tag: "error" as const, error: parent.error };
        const created = await tx.insertSeason({
          orgId: principal.orgId,
          storyId: parent.value.id,
          seasonNumber: input.seasonNumber,
          title,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: CREATIVE_AUDIT_ACTIONS[6],
          targetType: "season",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { title, storyId: parent.value.id, seasonNumber: input.seasonNumber },
        });
        return { tag: "ok" as const, row: created };
      });
      return outcomeOf(row);
    },

    async createEpisode(principal, input: CreateEpisodeInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const title = input.title.trim();
      if (title.length < 1 || title.length > 300) return err("invalid_input", "title must be 1..300 characters");
      if (!Number.isInteger(input.episodeNumber) || input.episodeNumber < 1)
        return err("invalid_input", "episodeNumber must be a positive integer");
      if (!input.seasonId && !input.storyId)
        return err("invalid_input", "episode requires seasonId or storyId");

      const row = await inTx(repo, async (tx) => {
        let seasonId: string | null = null;
        let storyId: string | null = null;
        let productionId: string | null = null;
        if (input.seasonId) {
          if (!UUID_RE.test(input.seasonId)) return { tag: "error" as const, error: { reason: "invalid_input" as const, message: "seasonId must be a valid uuid" } };
          const parent = await requireParent<SeasonRecord>(tx, "season", input.seasonId, principal.orgId);
          if (!parent.ok) return { tag: "error" as const, error: parent.error };
          seasonId = parent.value.id;
        }
        if (input.storyId) {
          if (!UUID_RE.test(input.storyId)) return { tag: "error" as const, error: { reason: "invalid_input" as const, message: "storyId must be a valid uuid" } };
          const parent = await requireParent<StoryRecord>(tx, "story", input.storyId, principal.orgId);
          if (!parent.ok) return { tag: "error" as const, error: parent.error };
          storyId = parent.value.id;
        }
        if (input.productionId) {
          if (!UUID_RE.test(input.productionId)) return { tag: "error" as const, error: { reason: "invalid_input" as const, message: "productionId must be a valid uuid" } };
          // Cross-tenant integrity applies to the production reference too:
          // must exist, be same-org, and not be archived/cancelled (read-only
          // over productions — no Production behavior change).
          const prod = await tx.findProductionRef(input.productionId);
          if (!prod) return { tag: "error" as const, error: { reason: "not_found" as const, message: "referenced production does not exist" } };
          if (prod.orgId !== principal.orgId) return { tag: "error" as const, error: { reason: "not_found" as const, message: "referenced production does not exist" } };
          if (prod.status === "archived" || prod.status === "cancelled")
            return { tag: "error" as const, error: { reason: "inactive_parent" as const, message: "referenced production is archived/cancelled" } };
          productionId = prod.id;
        }
        const created = await tx.insertEpisode({
          orgId: principal.orgId,
          seasonId,
          storyId,
          // D2.20: productionId is settable at creation ONLY — validated
          // above as a same-org non-terminal productions row (read-only, no
          // Production behavior change); null stays null.
          productionId,
          episodeNumber: input.episodeNumber,
          title,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: CREATIVE_AUDIT_ACTIONS[8],
          targetType: "episode",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { title, seasonId, storyId, episodeNumber: input.episodeNumber },
        });
        return { tag: "ok" as const, row: created };
      });
      return outcomeOf(row);
    },

    async createScene(principal, input: CreateSceneInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const title = input.title.trim();
      if (title.length < 1 || title.length > 300) return err("invalid_input", "title must be 1..300 characters");
      if (input.synopsis != null && input.synopsis.length > 4000)
        return err("invalid_input", "synopsis must be at most 4000 characters");
      if (!Number.isInteger(input.orderIndex) || input.orderIndex < 0)
        return err("invalid_input", "orderIndex must be a non-negative integer");
      if (!input.storyId && !input.episodeId)
        return err("invalid_input", "scene requires storyId or episodeId");

      const row = await inTx(repo, async (tx) => {
        let storyId: string | null = null;
        let episodeId: string | null = null;
        let productionId: string | null = null;
        if (input.storyId) {
          if (!UUID_RE.test(input.storyId)) return { tag: "error" as const, error: { reason: "invalid_input" as const, message: "storyId must be a valid uuid" } };
          const parent = await requireParent<StoryRecord>(tx, "story", input.storyId, principal.orgId);
          if (!parent.ok) return { tag: "error" as const, error: parent.error };
          storyId = parent.value.id;
        }
        if (input.episodeId) {
          if (!UUID_RE.test(input.episodeId)) return { tag: "error" as const, error: { reason: "invalid_input" as const, message: "episodeId must be a valid uuid" } };
          const parent = await requireParent<EpisodeRecord>(tx, "episode", input.episodeId, principal.orgId);
          if (!parent.ok) return { tag: "error" as const, error: parent.error };
          episodeId = parent.value.id;
        }
        if (input.productionId) {
          if (!UUID_RE.test(input.productionId)) return { tag: "error" as const, error: { reason: "invalid_input" as const, message: "productionId must be a valid uuid" } };
          // Cross-tenant integrity applies to the production reference too.
          const prod = await tx.findProductionRef(input.productionId);
          if (!prod) return { tag: "error" as const, error: { reason: "not_found" as const, message: "referenced production does not exist" } };
          if (prod.orgId !== principal.orgId) return { tag: "error" as const, error: { reason: "not_found" as const, message: "referenced production does not exist" } };
          if (prod.status === "archived" || prod.status === "cancelled")
            return { tag: "error" as const, error: { reason: "inactive_parent" as const, message: "referenced production is archived/cancelled" } };
          productionId = prod.id;
        }
        const created = await tx.insertScene({
          orgId: principal.orgId,
          storyId,
          episodeId,
          // D2.20: productionId settable at creation ONLY (no update path).
          productionId,
          orderIndex: input.orderIndex,
          title,
          synopsis: input.synopsis ?? null,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: CREATIVE_AUDIT_ACTIONS[10],
          targetType: "scene",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { title, storyId, episodeId, orderIndex: input.orderIndex },
        });
        return { tag: "ok" as const, row: created };
      });
      return outcomeOf(row);
    },

    async createShot(principal, input: CreateShotInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const description = input.description.trim();
      if (description.length < 1 || description.length > 2000)
        return err("invalid_input", "description must be 1..2000 characters");
      const aspect = input.aspect.trim();
      if (aspect.length < 1 || aspect.length > 20) return err("invalid_input", "aspect must be 1..20 characters");
      if (!Number.isInteger(input.orderIndex) || input.orderIndex < 0)
        return err("invalid_input", "orderIndex must be a non-negative integer");
      if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 1)
        return err("invalid_input", "durationSeconds must be a positive integer");
      if (!Number.isInteger(input.fps) || input.fps < 1 || input.fps > 240)
        return err("invalid_input", "fps must be between 1 and 240");
      if (!UUID_RE.test(input.sceneId)) return err("invalid_input", "sceneId must be a valid uuid");

      const row = await inTx(repo, async (tx) => {
        const parent = await requireParent<SceneRecord>(tx, "scene", input.sceneId, principal.orgId);
        if (!parent.ok) return { tag: "error" as const, error: parent.error };
        const created = await tx.insertShot({
          orgId: principal.orgId,
          sceneId: parent.value.id,
          orderIndex: input.orderIndex,
          description,
          aspect,
          durationSeconds: input.durationSeconds,
          fps: input.fps,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: CREATIVE_AUDIT_ACTIONS[12],
          targetType: "shot",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { sceneId: parent.value.id, orderIndex: input.orderIndex, aspect },
        });
        return { tag: "ok" as const, row: created };
      });
      return outcomeOf(row);
    },

    // -----------------------------------------------------------------------
    // Lifecycle transitions (creative.manage, D2.20-6)
    // -----------------------------------------------------------------------
    async changeStatus(principal, kind: CreativeAggregateKind, input: StatusChangeInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(input.id)) return err("invalid_input", "id must be a valid uuid");
      if (!(statusesForKind(kind) as readonly string[]).includes(input.status))
        return err("invalid_status_transition", `status ${input.status} is not valid for ${kind}`);

      const apply = async <T extends { id: string; orgId: string; status: string }>(
        auditAction: (typeof CREATIVE_AUDIT_ACTIONS)[number],
        targetType: "universe" | "world" | "story" | "season" | "episode" | "scene" | "shot",
        find: (tx: CreativeTransaction) => Promise<T | null>,
        set: (tx: CreativeTransaction, id: string, status: string) => Promise<T | null>,
      ): Promise<CreativeResult<T>> => {
        return inTx(repo, async (tx) => {
          const current = await find(tx);
          // IDOR-safe: cross-org targets are indistinguishable from absent.
          if (!current) return err("not_found", "aggregate does not exist");
          if (current.orgId !== principal.orgId) return err("not_found", "aggregate does not exist");
          const transitionOk = isStoryKind(kind)
            ? validStoryTransition(current.status as StoryStatus, input.status as StoryStatus)
            : validChainTransition(current.status as ChainStatus, input.status as ChainStatus);
          if (!transitionOk) {
            return err(
              "invalid_status_transition",
              `cannot transition ${kind} from ${current.status} to ${input.status}`,
            );
          }
          const updated = await set(tx, input.id, input.status);
          if (!updated) return err("not_found", "aggregate disappeared");
          await tx.appendAudit({
            actorId: principal.operatorId,
            action: auditAction,
            targetType,
            targetId: input.id,
            organizationId: principal.orgId,
            metadata: { from: current.status, to: input.status },
          });
          return ok(updated);
        });
      };

      switch (kind) {
        case "universe":
          return apply(
            CREATIVE_AUDIT_ACTIONS[1],
            "universe",
            (tx) => tx.findUniverseById(input.id),
            (tx, id, s) => tx.setUniverseStatus(id, s as ChainStatus),
          );
        case "world":
          return apply(
            CREATIVE_AUDIT_ACTIONS[3],
            "world",
            (tx) => tx.findWorldById(input.id),
            (tx, id, s) => tx.setWorldStatus(id, s as ChainStatus),
          );
        case "story":
          return apply(
            CREATIVE_AUDIT_ACTIONS[5],
            "story",
            (tx) => tx.findStoryById(input.id),
            (tx, id, s) => tx.setStoryStatus(id, s as StoryStatus),
          );
        case "season":
          return apply(
            CREATIVE_AUDIT_ACTIONS[7],
            "season",
            (tx) => tx.findSeasonById(input.id),
            (tx, id, s) => tx.setSeasonStatus(id, s as ChainStatus),
          );
        case "episode":
          return apply(
            CREATIVE_AUDIT_ACTIONS[9],
            "episode",
            (tx) => tx.findEpisodeById(input.id),
            (tx, id, s) => tx.setEpisodeStatus(id, s as ChainStatus),
          );
        case "scene":
          return apply(
            CREATIVE_AUDIT_ACTIONS[11],
            "scene",
            (tx) => tx.findSceneById(input.id),
            (tx, id, s) => tx.setSceneStatus(id, s as ChainStatus),
          );
        case "shot":
          return apply(
            CREATIVE_AUDIT_ACTIONS[13],
            "shot",
            (tx) => tx.findShotById(input.id),
            (tx, id, s) => tx.setShotStatus(id, s as ChainStatus),
          );
      }
    },

    // -----------------------------------------------------------------------
    // Reads (creative.read) — organization-scoped
    // -----------------------------------------------------------------------
    async listUniverses(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listUniverses(principal.orgId, clampLimit(limit)));
    },
    async listWorlds(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listWorlds(principal.orgId, clampLimit(limit)));
    },
    async listStories(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listStories(principal.orgId, clampLimit(limit)));
    },
    async listSeasons(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listSeasons(principal.orgId, clampLimit(limit)));
    },
    async listEpisodes(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listEpisodes(principal.orgId, clampLimit(limit)));
    },
    async listScenes(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listScenes(principal.orgId, clampLimit(limit)));
    },
    async listShots(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listShots(principal.orgId, clampLimit(limit)));
    },
  };
};

/** Narrow the in-tx tagged outcome into the service result type. */
type Tagged<T> =
  | { readonly tag: "ok"; readonly row: T }
  | { readonly tag: "error"; readonly error: { readonly reason: import("./types").CreativeErrorReason; readonly message: string } };

const outcomeOf = <T>(outcome: Tagged<T>): CreativeResult<T> =>
  outcome.tag === "ok" ? ok(outcome.row) : err(outcome.error.reason, outcome.error.message);
