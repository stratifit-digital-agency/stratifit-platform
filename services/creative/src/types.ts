/**
 * Creative / Story domain service types (Stage 2.20, D2.20-1..D2.20-9).
 *
 * services/creative owns bounded context 3 (DM section 8): the seven-level
 * narrative hierarchy
 *
 *   universes → worlds → stories → seasons → episodes → scenes → shots
 *
 * HARD BOUNDARIES (frozen):
 *  - D2.20-2: world-building catalog (locations/props/fictional orgs/
 *    vehicles/rules/timelines) DEFERRED — worlds are structural nodes only.
 *  - D2.20-3: scripts DEFERRED — no script storage (DM Open Question 8 stays
 *    open); stories carry a numeric version only.
 *  - D2.20-4: NO events — taxonomy stays exactly 36; audit rows carry the
 *    facts (D2.15-3/D2.16-7 precedent).
 *  - D2.20-7: Control-only — no Media surface; `campaign_creative` remains
 *    fail-closed; no publishing mediation.
 *  - D2.20-5: authorization via creative.manage (writes) / creative.read
 *    (reads) — never derived from production.* capabilities.
 *  - D2.20-8: fourteen frozen audit actions, same-transaction (D2.4-1).
 *
 * Parent-chain integrity (People precedent): every parent reference is
 * validated INSIDE the mutation transaction — existence, SAME-ORG, and
 * non-retired status; cross-org fails closed as not_found (no existence
 * leak). Story/episode/scene may carry a nullable production_id, settable at
 * creation ONLY — Stage 2.20 has no update path for it (Production behavior
 * untouched).
 */
import type { ControlCapability } from "@stratifit/permissions";

// ---------------------------------------------------------------------------
// Lifecycles (DB CHECK mirrors, D2.20-6)
// ---------------------------------------------------------------------------

/** Six aggregates share draft → active → retired (retired terminal). */
export const CHAIN_STATUSES = ["draft", "active", "retired"] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

/** Stories add the terminal `completed` (only exit: retired). */
export const STORY_STATUSES = ["draft", "active", "completed", "retired"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/** Frozen story.kind vocabulary (Stage 2.20 plan §14, user-confirmed). */
export const CREATIVE_STORY_KINDS = ["film", "series", "short", "campaign_narrative"] as const;
export type CreativeStoryKind = (typeof CREATIVE_STORY_KINDS)[number];

/** Slug shape mirror of the universes DB CHECK: ^[a-z0-9-]{3,64}$. */
export const SLUG_RE = /^[a-z0-9-]{3,64}$/;

// ---------------------------------------------------------------------------
// Aggregate kinds + URL mapping
// ---------------------------------------------------------------------------

export type CreativeAggregateKind =
  | "universe"
  | "world"
  | "story"
  | "season"
  | "episode"
  | "scene"
  | "shot";

export const CREATIVE_AGGREGATE_KINDS: readonly CreativeAggregateKind[] = [
  "universe",
  "world",
  "story",
  "season",
  "episode",
  "scene",
  "shot",
];

// ---------------------------------------------------------------------------
// Records (service-internal, mirror the Drizzle rows)
// ---------------------------------------------------------------------------

export interface UniverseRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorldRecord {
  readonly id: string;
  readonly orgId: string;
  readonly universeId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoryRecord {
  readonly id: string;
  readonly orgId: string;
  readonly worldId: string | null;
  readonly universeId: string | null;
  readonly title: string;
  readonly logline: string;
  readonly kind: CreativeStoryKind;
  readonly version: number;
  readonly status: StoryStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SeasonRecord {
  readonly id: string;
  readonly orgId: string;
  readonly storyId: string;
  readonly seasonNumber: number;
  readonly title: string;
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EpisodeRecord {
  readonly id: string;
  readonly orgId: string;
  readonly seasonId: string | null;
  readonly storyId: string | null;
  readonly productionId: string | null;
  readonly episodeNumber: number;
  readonly title: string;
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SceneRecord {
  readonly id: string;
  readonly orgId: string;
  readonly storyId: string | null;
  readonly episodeId: string | null;
  readonly productionId: string | null;
  readonly orderIndex: number;
  readonly title: string;
  readonly synopsis: string | null;
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ShotRecord {
  readonly id: string;
  readonly orgId: string;
  readonly sceneId: string;
  readonly orderIndex: number;
  readonly description: string;
  readonly aspect: string;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Same-transaction audit seam (D2.4-1 reused) + FROZEN audit actions
// ---------------------------------------------------------------------------

/** Audit entry accepted by the sanctioned admin-audit seam (identity D4 shape). */
export type CreativeAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType:
    | "universe"
    | "world"
    | "story"
    | "season"
    | "episode"
    | "scene"
    | "shot";
  targetId: string;
  /** Org scope for organization-scoped audit reads (D2.4-2). */
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}) => Promise<void>;

/**
 * Same-transaction audit writer (D2.4-1 reused). The adapter receives the
 * open transaction and appends inside it; rollback removes both.
 */
export interface CreativeAuditWriter {
  appendWithin(tx: unknown, entry: Parameters<CreativeAuditAppend>[0]): Promise<void>;
}

/** FROZEN audit actions (Stage 2.20 build authorization): exactly these fourteen. */
export const CREATIVE_AUDIT_ACTIONS = [
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
] as const;

// ---------------------------------------------------------------------------
// Command results (house style: discriminated, never throws)
// ---------------------------------------------------------------------------

export type CreativeErrorReason =
  | "unauthorized"
  | "not_found"
  | "cross_org_reference"
  | "inactive_parent"
  | "invalid_status_transition"
  | "invalid_slug"
  | "duplicate_slug"
  | "invalid_input";

export type CreativeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly reason: CreativeErrorReason; readonly message: string } };

export const ok = <T>(value: T): CreativeResult<T> => ({ ok: true, value });
export const err = <T>(reason: CreativeErrorReason, message: string): CreativeResult<T> => ({
  ok: false,
  error: { reason, message },
});

// ---------------------------------------------------------------------------
// Repository port (implemented by the Drizzle adapter in repository.ts)
// ---------------------------------------------------------------------------

export interface CreativeRepository {
  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction whose scoped
   * view is `CreativeTransaction`, so a security-critical mutation can never
   * commit without its audit record.
   */
  runInTransaction<T>(work: (tx: CreativeTransaction) => Promise<T>): Promise<T>;

  // reads (org-scoped; pool-level)
  findUniverseById(id: string): Promise<UniverseRecord | null>;
  listUniverses(orgId: string, limit: number): Promise<readonly UniverseRecord[]>;
  findWorldById(id: string): Promise<WorldRecord | null>;
  listWorlds(orgId: string, limit: number): Promise<readonly WorldRecord[]>;
  findStoryById(id: string): Promise<StoryRecord | null>;
  listStories(orgId: string, limit: number): Promise<readonly StoryRecord[]>;
  findSeasonById(id: string): Promise<SeasonRecord | null>;
  listSeasons(orgId: string, limit: number): Promise<readonly SeasonRecord[]>;
  findEpisodeById(id: string): Promise<EpisodeRecord | null>;
  listEpisodes(orgId: string, limit: number): Promise<readonly EpisodeRecord[]>;
  findSceneById(id: string): Promise<SceneRecord | null>;
  listScenes(orgId: string, limit: number): Promise<readonly SceneRecord[]>;
  findShotById(id: string): Promise<ShotRecord | null>;
  listShots(orgId: string, limit: number): Promise<readonly ShotRecord[]>;
  /** Duplicate-slug guard (UNIQUE(org, slug) backstop). */
  findUniverseBySlug(orgId: string, slug: string): Promise<UniverseRecord | null>;

  // direct mutations (test-only sequential fallback; the service always uses
  // the transactional path for audited mutations)
  insertUniverse(input: { orgId: string; name: string; slug: string; description: string | null }): Promise<UniverseRecord>;
  insertWorld(input: { orgId: string; universeId: string; name: string; description: string | null }): Promise<WorldRecord>;
  insertStory(input: {
    orgId: string;
    worldId: string | null;
    universeId: string | null;
    title: string;
    logline: string;
    kind: CreativeStoryKind;
    version: number;
  }): Promise<StoryRecord>;
  insertSeason(input: { orgId: string; storyId: string; seasonNumber: number; title: string }): Promise<SeasonRecord>;
  insertEpisode(input: {
    orgId: string;
    seasonId: string | null;
    storyId: string | null;
    productionId: string | null;
    episodeNumber: number;
    title: string;
  }): Promise<EpisodeRecord>;
  insertScene(input: {
    orgId: string;
    storyId: string | null;
    episodeId: string | null;
    productionId: string | null;
    orderIndex: number;
    title: string;
    synopsis: string | null;
  }): Promise<SceneRecord>;
  insertShot(input: {
    orgId: string;
    sceneId: string;
    orderIndex: number;
    description: string;
    aspect: string;
    durationSeconds: number;
    fps: number;
  }): Promise<ShotRecord>;
  setUniverseStatus(id: string, status: ChainStatus): Promise<UniverseRecord | null>;
  setWorldStatus(id: string, status: ChainStatus): Promise<WorldRecord | null>;
  setStoryStatus(id: string, status: StoryStatus): Promise<StoryRecord | null>;
  setSeasonStatus(id: string, status: ChainStatus): Promise<SeasonRecord | null>;
  setEpisodeStatus(id: string, status: ChainStatus): Promise<EpisodeRecord | null>;
  setSceneStatus(id: string, status: ChainStatus): Promise<SceneRecord | null>;
  setShotStatus(id: string, status: ChainStatus): Promise<ShotRecord | null>;
}

/**
 * Transaction-scoped persistence + audit append (D2.4-1, reused): every
 * security-critical mutation and its audit record run on the SAME database
 * transaction. Implementations MUST NOT commit or roll back inside
 * `appendAudit` — transaction ownership stays with `runInTransaction`.
 */
export interface CreativeTransaction {
  findUniverseById(id: string): Promise<UniverseRecord | null>;
  findWorldById(id: string): Promise<WorldRecord | null>;
  findStoryById(id: string): Promise<StoryRecord | null>;
  findSeasonById(id: string): Promise<SeasonRecord | null>;
  findEpisodeById(id: string): Promise<EpisodeRecord | null>;
  findSceneById(id: string): Promise<SceneRecord | null>;
  findShotById(id: string): Promise<ShotRecord | null>;
  findUniverseBySlug(orgId: string, slug: string): Promise<UniverseRecord | null>;
  /**
   * Parent-integrity read over the PRODUCTIONS table (read-only; no
   * Production behavior change): the minimal same-org facts needed to bind
   * a nullable production_id at creation. Returns null when absent.
   */
  findProductionRef(id: string): Promise<{ readonly id: string; readonly orgId: string; readonly status: string } | null>;
  insertUniverse(input: { orgId: string; name: string; slug: string; description: string | null }): Promise<UniverseRecord>;
  insertWorld(input: { orgId: string; universeId: string; name: string; description: string | null }): Promise<WorldRecord>;
  insertStory(input: {
    orgId: string;
    worldId: string | null;
    universeId: string | null;
    title: string;
    logline: string;
    kind: CreativeStoryKind;
    version: number;
  }): Promise<StoryRecord>;
  insertSeason(input: { orgId: string; storyId: string; seasonNumber: number; title: string }): Promise<SeasonRecord>;
  insertEpisode(input: {
    orgId: string;
    seasonId: string | null;
    storyId: string | null;
    productionId: string | null;
    episodeNumber: number;
    title: string;
  }): Promise<EpisodeRecord>;
  insertScene(input: {
    orgId: string;
    storyId: string | null;
    episodeId: string | null;
    productionId: string | null;
    orderIndex: number;
    title: string;
    synopsis: string | null;
  }): Promise<SceneRecord>;
  insertShot(input: {
    orgId: string;
    sceneId: string;
    orderIndex: number;
    description: string;
    aspect: string;
    durationSeconds: number;
    fps: number;
  }): Promise<ShotRecord>;
  setUniverseStatus(id: string, status: ChainStatus): Promise<UniverseRecord | null>;
  setWorldStatus(id: string, status: ChainStatus): Promise<WorldRecord | null>;
  setStoryStatus(id: string, status: StoryStatus): Promise<StoryRecord | null>;
  setSeasonStatus(id: string, status: ChainStatus): Promise<SeasonRecord | null>;
  setEpisodeStatus(id: string, status: ChainStatus): Promise<EpisodeRecord | null>;
  setSceneStatus(id: string, status: ChainStatus): Promise<SceneRecord | null>;
  setShotStatus(id: string, status: ChainStatus): Promise<ShotRecord | null>;
  appendAudit(entry: Parameters<CreativeAuditAppend>[0]): Promise<void>;
}

/** Server-derived Control operator principal (identity-resolved, no client authority). */
export interface CreativePrincipal {
  readonly operatorId: string;
  readonly orgId: string;
  readonly capabilities: readonly ControlCapability[];
}

// ---------------------------------------------------------------------------
// Create inputs (org/actor are NEVER inputs — server-derived principal only)
// ---------------------------------------------------------------------------

export interface CreateUniverseInput {
  readonly name: string;
  readonly slug: string;
  readonly description?: string | null;
}

export interface CreateWorldInput {
  readonly universeId: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface CreateStoryInput {
  readonly worldId?: string | null;
  readonly universeId?: string | null;
  readonly title: string;
  readonly logline: string;
  readonly kind: CreativeStoryKind;
  readonly version?: number;
}

export interface CreateSeasonInput {
  readonly storyId: string;
  readonly seasonNumber: number;
  readonly title: string;
}

export interface CreateEpisodeInput {
  readonly seasonId?: string | null;
  readonly storyId?: string | null;
  /** Nullable, settable at creation ONLY — no Stage 2.20 update path exists. */
  readonly productionId?: string | null;
  readonly episodeNumber: number;
  readonly title: string;
}

export interface CreateSceneInput {
  readonly storyId?: string | null;
  readonly episodeId?: string | null;
  /** Nullable, settable at creation ONLY — no Stage 2.20 update path exists. */
  readonly productionId?: string | null;
  readonly orderIndex: number;
  readonly title: string;
  readonly synopsis?: string | null;
}

export interface CreateShotInput {
  readonly sceneId: string;
  readonly orderIndex: number;
  readonly description: string;
  readonly aspect: string;
  readonly durationSeconds: number;
  readonly fps: number;
}

/** Status payload: stories accept the extended set; all others the chain set. */
export type StatusChangeInput = { readonly id: string; readonly status: ChainStatus | StoryStatus };

export interface CreativeServiceDeps {
  readonly repository: CreativeRepository;
}

export interface CreativeService {
  // ---- Control authoring (creative.manage) --------------------------------
  createUniverse(principal: CreativePrincipal, input: CreateUniverseInput): Promise<CreativeResult<UniverseRecord>>;
  createWorld(principal: CreativePrincipal, input: CreateWorldInput): Promise<CreativeResult<WorldRecord>>;
  createStory(principal: CreativePrincipal, input: CreateStoryInput): Promise<CreativeResult<StoryRecord>>;
  createSeason(principal: CreativePrincipal, input: CreateSeasonInput): Promise<CreativeResult<SeasonRecord>>;
  createEpisode(principal: CreativePrincipal, input: CreateEpisodeInput): Promise<CreativeResult<EpisodeRecord>>;
  createScene(principal: CreativePrincipal, input: CreateSceneInput): Promise<CreativeResult<SceneRecord>>;
  createShot(principal: CreativePrincipal, input: CreateShotInput): Promise<CreativeResult<ShotRecord>>;

  /**
   * Lifecycle transitions, fail-closed (D2.20-6): six aggregates share
   * draft → active → retired (retired terminal); stories additionally carry
   * the terminal `completed` whose only exit is retired. No paused state.
   */
  changeStatus(
    principal: CreativePrincipal,
    kind: CreativeAggregateKind,
    input: StatusChangeInput,
  ): Promise<CreativeResult<UniverseRecord | WorldRecord | StoryRecord | SeasonRecord | EpisodeRecord | SceneRecord | ShotRecord>>;

  // ---- Reads (creative.read) ----------------------------------------------
  listUniverses(principal: CreativePrincipal, limit?: number): Promise<CreativeResult<readonly UniverseRecord[]>>;
  listWorlds(principal: CreativePrincipal, limit?: number): Promise<CreativeResult<readonly WorldRecord[]>>;
  listStories(principal: CreativePrincipal, limit?: number): Promise<CreativeResult<readonly StoryRecord[]>>;
  listSeasons(principal: CreativePrincipal, limit?: number): Promise<CreativeResult<readonly SeasonRecord[]>>;
  listEpisodes(principal: CreativePrincipal, limit?: number): Promise<CreativeResult<readonly EpisodeRecord[]>>;
  listScenes(principal: CreativePrincipal, limit?: number): Promise<CreativeResult<readonly SceneRecord[]>>;
  listShots(principal: CreativePrincipal, limit?: number): Promise<CreativeResult<readonly ShotRecord[]>>;
}
