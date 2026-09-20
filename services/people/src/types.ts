/**
 * People-domain service types (Stage 2.16, D2.16-1..D2.16-8).
 *
 * services/people owns the five-aggregate PEOPLE CHAIN (DM section 10,
 * bounded context 4):
 *
 *   digital_humans → characters → personas → ai_creators → creator_profiles
 *
 * HARD BOUNDARIES (frozen):
 *  - D2.16-1: chain-only five-table scope; voices/wardrobes are deferred.
 *  - D2.16-2: Rights is an OPTIONAL unwired port — absence = vacuous pass.
 *    No Rights tables/records/service exist anywhere in this stage.
 *  - D2.16-3: the four chain aggregates are Control-authored; creator_profiles
 *    is a PUBLICATION-AUTHORED SNAPSHOT family. There is NO arbitrary profile
 *    edit path: snapshots are written only through upsertProfileSnapshot
 *    (mediated by the publication flow) and unpublished only through
 *    unpublishCurrentSnapshot. Every snapshot is idempotent by
 *    publication_version_id; republish preserves history (previous current row
 *    → 'unpublished', new row → 'active'); nothing is hard-deleted.
 *  - D2.16-4: authorization uses the people.manage / people.read capability
 *    family (packages/permissions) — never production.publish.
 *  - D2.16-5/6: narrow read-only seams let Social resolve active creator
 *    follow targets and Publishing resolve the ai_creator_profile subject.
 *  - D2.16-7: NO events. People emits nothing; mediation is synchronous.
 */
import type { ControlCapability } from "@stratifit/permissions";

// ---------------------------------------------------------------------------
// Chain lifecycle (DB CHECK mirrors)
// ---------------------------------------------------------------------------

/** Chain aggregates share draft → active → retired (retired is terminal). */
export const CHAIN_STATUSES = ["draft", "active", "retired"] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

/** Snapshot family statuses (creator_profiles CHECK). */
export const PROFILE_STATUSES = ["active", "paused", "unpublished"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/**
 * AI Creator lifecycle (DM §32.11): draft → active ⇄ paused → retired — the
 * ONLY chain aggregate with the paused state (authorized freeze fix 1).
 */
export const AI_CREATOR_STATUSES = ["draft", "active", "paused", "retired"] as const;
export type AiCreatorStatus = (typeof AI_CREATOR_STATUSES)[number];

/** Handle shape mirror of the DB CHECK: ^[a-z0-9-]{3,64}$. */
export const HANDLE_RE = /^[a-z0-9-]{3,64}$/;

// ---------------------------------------------------------------------------
// Records (service-internal)
// ---------------------------------------------------------------------------

export interface DigitalHumanRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly appearanceRefs: readonly string[];
  readonly baseModelVersionRef: string | null;
  readonly baseWorkflowVersionRef: string | null;
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CharacterRecord {
  readonly id: string;
  readonly orgId: string;
  readonly digitalHumanId: string | null;
  readonly name: string;
  readonly bio: string | null;
  readonly visualRefs: readonly string[];
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PersonaRecord {
  readonly id: string;
  readonly orgId: string;
  readonly characterId: string;
  readonly name: string;
  readonly personality: string | null;
  readonly interests: readonly string[];
  readonly capabilities: readonly string[];
  readonly languages: readonly string[];
  readonly behaviorConfig: Readonly<Record<string, unknown>>;
  readonly status: ChainStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AiCreatorRecord {
  readonly id: string;
  readonly orgId: string;
  readonly personaId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly contentCategories: readonly string[];
  readonly communicationConfig: Readonly<Record<string, unknown>>;
  readonly isAi: boolean;
  readonly status: AiCreatorStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The publication-authored snapshot row. Exactly one CURRENT profile per
 * (org, aiCreator) — UNIQUE(org_id, ai_creator_id); historical snapshots are
 * retained with status 'unpublished' until superseded by a NEW publication.
 */
export interface CreatorProfileRecord {
  readonly id: string;
  readonly orgId: string;
  readonly aiCreatorId: string;
  readonly publicationId: string;
  readonly publicationVersionId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly personalitySnapshot: Readonly<Record<string, unknown>>;
  readonly interestsSnapshot: readonly string[];
  readonly avatarRef: string | null;
  readonly posterRef: string | null;
  readonly messagingEnabled: boolean;
  readonly status: ProfileStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Public-safe views (whitelist — the ONLY shapes Media ever sees)
// ---------------------------------------------------------------------------

/** Public creator card: opaque refs only, zero internal identifiers. */
export interface PublicCreatorView {
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly interests: readonly string[];
  /** Opaque asset-version reference — never a storage path/URL. */
  readonly avatarRef: string | null;
  readonly posterRef: string | null;
  readonly status: Extract<ProfileStatus, "active" | "paused">;
}

// ---------------------------------------------------------------------------
// Same-transaction audit seam (D2.4-1 reused) + FROZEN audit actions
// ---------------------------------------------------------------------------

/**
 * Audit entry accepted by the sanctioned admin-audit seam (same shape as the
 * identity D4 seam; composition roots map it to admin-audit's canonical entry).
 */
export type PeopleAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "digital_human" | "character" | "persona" | "ai_creator" | "creator_profile";
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
export interface PeopleAuditWriter {
  appendWithin(
    tx: unknown,
    entry: Parameters<PeopleAuditAppend>[0],
  ): Promise<void>;
}

/** FROZEN audit actions (Stage 2.16, build authorization §13): exactly these ten. */
export const PEOPLE_AUDIT_ACTIONS = [
  "people.digital_human_created",
  "people.digital_human_status_changed",
  "people.character_created",
  "people.character_status_changed",
  "people.persona_created",
  "people.persona_status_changed",
  "people.ai_creator_created",
  "people.ai_creator_status_changed",
  "people.profile_snapshot_authored",
  "people.profile_snapshot_unpublished",
] as const;

/**
 * System-originated actor identity for audit rows written outside an operator
 * context (e.g. future automation). audit_log.actor_id is a uuid (no FK,
 * opaque to admin-audit), so this is a DETERMINISTIC system UUID — never a
 * fabricated operator row id, never the literal string "system".
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------
// Command results (house style: discriminated, never throws)
// ---------------------------------------------------------------------------

export type PeopleErrorReason =
  | "unauthorized"
  | "not_found"
  | "cross_org_reference"
  | "inactive_parent"
  | "invalid_status_transition"
  | "invalid_handle"
  | "invalid_input"
  | "chain_broken"
  | "creator_targets_unsupported";

export type PeopleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly reason: PeopleErrorReason; readonly message: string } };

export const ok = <T>(value: T): PeopleResult<T> => ({ ok: true, value });
export const err = <T>(reason: PeopleErrorReason, message: string): PeopleResult<T> => ({
  ok: false,
  error: { reason, message },
});

// ---------------------------------------------------------------------------
// Repository port (implemented by the Drizzle adapter in repository.ts)
// ---------------------------------------------------------------------------

export interface PeopleRepository {
  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction whose scoped
   * view is `PeopleTransaction`, so a security-critical mutation can never
   * commit without its audit record. Optional: repositories without
   * transaction support fall back to direct mutations (audit skipped —
   * documented test-only fallback, mirroring production-engine).
   */
  runInTransaction?<T>(work: (tx: PeopleTransaction) => Promise<T>): Promise<T>;
  // digital_humans
  insertDigitalHuman(input: {
    orgId: string;
    name: string;
    appearanceRefs: readonly string[];
    baseModelVersionRef: string | null;
    baseWorkflowVersionRef: string | null;
  }): Promise<DigitalHumanRecord>;
  findDigitalHumanById(id: string): Promise<DigitalHumanRecord | null>;
  listDigitalHumans(orgId: string, limit: number): Promise<readonly DigitalHumanRecord[]>;
  setDigitalHumanStatus(id: string, status: ChainStatus): Promise<DigitalHumanRecord | null>;

  // characters
  insertCharacter(input: {
    orgId: string;
    digitalHumanId: string | null;
    name: string;
    bio: string | null;
    visualRefs: readonly string[];
  }): Promise<CharacterRecord>;
  findCharacterById(id: string): Promise<CharacterRecord | null>;
  listCharacters(orgId: string, limit: number): Promise<readonly CharacterRecord[]>;
  setCharacterStatus(id: string, status: ChainStatus): Promise<CharacterRecord | null>;

  // personas
  insertPersona(input: {
    orgId: string;
    characterId: string;
    name: string;
    personality: string | null;
    interests: readonly string[];
    capabilities: readonly string[];
    languages: readonly string[];
    behaviorConfig: Record<string, unknown>;
  }): Promise<PersonaRecord>;
  findPersonaById(id: string): Promise<PersonaRecord | null>;
  listPersonas(orgId: string, limit: number): Promise<readonly PersonaRecord[]>;
  setPersonaStatus(id: string, status: ChainStatus): Promise<PersonaRecord | null>;

  // ai_creators
  insertAiCreator(input: {
    orgId: string;
    personaId: string;
    handle: string;
    displayName: string;
    capabilities: readonly string[];
    contentCategories: readonly string[];
    communicationConfig: Record<string, unknown>;
  }): Promise<AiCreatorRecord>;
  findAiCreatorById(id: string): Promise<AiCreatorRecord | null>;
  findAiCreatorByHandle(orgId: string, handle: string): Promise<AiCreatorRecord | null>;
  listAiCreators(orgId: string, limit: number): Promise<readonly AiCreatorRecord[]>;
  setAiCreatorStatus(id: string, status: AiCreatorStatus): Promise<AiCreatorRecord | null>;

  // creator_profiles — the publication-authored snapshot family
  /** Current snapshot for (org, creator) in ANY status, or null. */
  findCurrentProfile(orgId: string, aiCreatorId: string): Promise<CreatorProfileRecord | null>;
  /** Idempotency lookup by publication version. */
  findProfileByVersionId(publicationVersionId: string): Promise<CreatorProfileRecord | null>;
  findActiveProfileByHandle(handle: string): Promise<CreatorProfileRecord | null>;
  findActiveProfileByCreatorId(aiCreatorId: string): Promise<CreatorProfileRecord | null>;
  insertProfile(input: {
    orgId: string;
    aiCreatorId: string;
    publicationId: string;
    publicationVersionId: string;
    handle: string;
    displayName: string;
    bio: string | null;
    personalitySnapshot: Record<string, unknown>;
    interestsSnapshot: readonly string[];
    avatarRef: string | null;
    posterRef: string | null;
    messagingEnabled: boolean;
  }): Promise<CreatorProfileRecord>;
  /** Retire the current row (status → unpublished) — never a delete. */
  retireProfile(profileId: string): Promise<CreatorProfileRecord>;
  /** Pause/reactivate the CURRENT snapshot (status active ↔ paused). */
  setProfileStatus(profileId: string, status: ProfileStatus): Promise<CreatorProfileRecord | null>;
  listActiveProfiles(limit: number): Promise<readonly CreatorProfileRecord[]>;
  listProfilesByOrg(orgId: string, limit: number): Promise<readonly CreatorProfileRecord[]>;
}

// ---------------------------------------------------------------------------
// Narrow read-only seams (D2.16-5 Social, D2.16-6 Publishing)
// ---------------------------------------------------------------------------

/**
 * Social's follow-target resolution: an ACTIVE profile only. The port returns
 * the minimal same-org facts Social needs; handles/refs stay opaque to callers.
 */
export interface CreatorFollowPort {
  /** Active profile for the exact profile id (D2.16-5 target resolution). */
  findActiveProfileById(
    profileId: string,
  ): Promise<{ readonly id: string; readonly orgId: string; readonly handle: string } | null>;
}

/**
 * Publishing's ai_creator_profile subject resolution (D2.16-6): the subject
 * reference is an AI-CREATOR id; it resolves only when the creator is active
 * AND carries a live (status = active) current profile in the SAME org.
 */
export interface CreatorSubjectPort {
  resolveActiveSubject(
    orgId: string,
    aiCreatorId: string,
  ): Promise<{
    readonly aiCreatorId: string;
    readonly orgId: string;
    readonly handle: string;
    readonly profileId: string;
    readonly profileStatus: "active";
  } | null>;
}

// ---------------------------------------------------------------------------
// Rights seam (D2.16-2) — declared, UNWIRED, vacuous-pass
// ---------------------------------------------------------------------------

/**
 * Optional future Rights verdict port. Stage 2.16 ships NO implementation:
 * when the port is ABSENT the service treats rights as vacuously passed
 * (no declared requirements). A future Rights stage may inject a resolver
 * whose declared-but-unmet verdict FAILS CLOSED chain authoring.
 */
export interface PeopleRightsPort {
  resolveRights(input: {
    orgId: string;
    subjectKind: "digital_human" | "character" | "persona" | "ai_creator";
    subjectId: string;
  }): Promise<{ readonly declared: boolean; readonly met: boolean }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Transaction-scoped persistence + audit append (D2.4-1, reused not
 * duplicated): every security-critical mutation and its audit record run on
 * the SAME database transaction. Implementations MUST NOT commit or roll
 * back inside `appendAudit` — transaction ownership stays with
 * `runInTransaction`.
 */
export interface PeopleTransaction {
  insertDigitalHuman(input: {
    orgId: string;
    name: string;
    appearanceRefs: readonly string[];
    baseModelVersionRef: string | null;
    baseWorkflowVersionRef: string | null;
  }): Promise<DigitalHumanRecord>;
  findDigitalHumanById(id: string): Promise<DigitalHumanRecord | null>;
  setDigitalHumanStatus(id: string, status: ChainStatus): Promise<DigitalHumanRecord | null>;
  insertCharacter(input: {
    orgId: string;
    digitalHumanId: string | null;
    name: string;
    bio: string | null;
    visualRefs: readonly string[];
  }): Promise<CharacterRecord>;
  findCharacterById(id: string): Promise<CharacterRecord | null>;
  setCharacterStatus(id: string, status: ChainStatus): Promise<CharacterRecord | null>;
  insertPersona(input: {
    orgId: string;
    characterId: string;
    name: string;
    personality: string | null;
    interests: readonly string[];
    capabilities: readonly string[];
    languages: readonly string[];
    behaviorConfig: Record<string, unknown>;
  }): Promise<PersonaRecord>;
  findPersonaById(id: string): Promise<PersonaRecord | null>;
  setPersonaStatus(id: string, status: ChainStatus): Promise<PersonaRecord | null>;
  insertAiCreator(input: {
    orgId: string;
    personaId: string;
    handle: string;
    displayName: string;
    capabilities: readonly string[];
    contentCategories: readonly string[];
    communicationConfig: Record<string, unknown>;
  }): Promise<AiCreatorRecord>;
  findAiCreatorById(id: string): Promise<AiCreatorRecord | null>;
  findAiCreatorByHandle(orgId: string, handle: string): Promise<AiCreatorRecord | null>;
  setAiCreatorStatus(id: string, status: AiCreatorStatus): Promise<AiCreatorRecord | null>;
  /**
   * Mediation-only narrow read (authorized freeze fix 2): the orgs owning the
   * publication version AND its parent publication, or null when absent.
   * Read-only; no mutation surface is exposed for publications.
   */
  findPublicationVersionOrg(
    publicationId: string,
    publicationVersionId: string,
  ): Promise<{ readonly versionOrgId: string; readonly publicationOrgId: string } | null>;
  findCurrentProfile(orgId: string, aiCreatorId: string): Promise<CreatorProfileRecord | null>;
  findProfileByVersionId(publicationVersionId: string): Promise<CreatorProfileRecord | null>;
  insertProfile(input: {
    orgId: string;
    aiCreatorId: string;
    publicationId: string;
    publicationVersionId: string;
    handle: string;
    displayName: string;
    bio: string | null;
    personalitySnapshot: Record<string, unknown>;
    interestsSnapshot: readonly string[];
    avatarRef: string | null;
    posterRef: string | null;
    messagingEnabled: boolean;
  }): Promise<CreatorProfileRecord>;
  retireProfile(profileId: string): Promise<CreatorProfileRecord>;
  appendAudit(entry: Parameters<PeopleAuditAppend>[0]): Promise<void>;
}

/** Server-derived Control operator principal (identity-resolved, no client authority). */
export interface PeoplePrincipal {
  readonly operatorId: string;
  readonly orgId: string;
  readonly capabilities: readonly ControlCapability[];
}

export type PeopleAggregateKind =
  | "digital_human"
  | "character"
  | "persona"
  | "ai_creator";

export interface CreateDigitalHumanInput {
  readonly name: string;
  readonly appearanceRefs?: readonly string[];
  readonly baseModelVersionRef?: string | null;
  readonly baseWorkflowVersionRef?: string | null;
}

export interface CreateCharacterInput {
  readonly digitalHumanId?: string | null;
  readonly name: string;
  readonly bio?: string | null;
  readonly visualRefs?: readonly string[];
}

export interface CreatePersonaInput {
  readonly characterId: string;
  readonly name: string;
  readonly personality?: string | null;
  readonly interests?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly languages?: readonly string[];
  readonly behaviorConfig?: Record<string, unknown>;
}

export interface CreateAiCreatorInput {
  readonly personaId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly capabilities?: readonly string[];
  readonly contentCategories?: readonly string[];
  readonly communicationConfig?: Record<string, unknown>;
}

/**
 * Status payload: chain aggregates accept the shared draft/active/retired
 * set; ai_creator additionally accepts paused (validated per-kind in the
 * service — paused on other kinds fails closed).
 */
export type StatusChangeInput = { readonly id: string; readonly status: ChainStatus | AiCreatorStatus };

/**
 * Snapshot input derived SERVER-SIDE by the publication mediation (Control
 * composition root) from the durable publication record — never from client
 * body fields (D2.16-3 anti-spoofing).
 */
export interface ProfileSnapshotInput {
  readonly orgId: string;
  readonly aiCreatorId: string;
  readonly publicationId: string;
  readonly publicationVersionId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly personalitySnapshot: Record<string, unknown>;
  readonly interestsSnapshot: readonly string[];
  readonly avatarRef: string | null;
  readonly posterRef: string | null;
  readonly messagingEnabled: boolean;
}

/** Result of upsertProfileSnapshot (D2.16-3 lifecycle). */
export type SnapshotOutcome =
  | { readonly kind: "created"; readonly profileId: string; readonly publicationVersionId: string }
  | { readonly kind: "replayed"; readonly profileId: string; readonly publicationVersionId: string };

export interface PeopleServiceDeps {
  readonly repository: PeopleRepository;
  /** D2.16-2: OPTIONAL Rights port — UNWIRED in production; absent = vacuous pass. */
  readonly rights?: PeopleRightsPort;
}

export interface PeopleService {
  // ---- Control authoring (people.manage) --------------------------------
  createDigitalHuman(
    principal: PeoplePrincipal,
    input: CreateDigitalHumanInput,
  ): Promise<PeopleResult<DigitalHumanRecord>>;
  createCharacter(
    principal: PeoplePrincipal,
    input: CreateCharacterInput,
  ): Promise<PeopleResult<CharacterRecord>>;
  createPersona(
    principal: PeoplePrincipal,
    input: CreatePersonaInput,
  ): Promise<PeopleResult<PersonaRecord>>;
  createAiCreator(
    principal: PeoplePrincipal,
    input: CreateAiCreatorInput,
  ): Promise<PeopleResult<AiCreatorRecord>>;

  /**
   * Lifecycle transitions, fail-closed. Shared chain: draft → active →
   * retired (draft → retired permitted, per the existing approved chain
   * semantics). AI Creator (DM §32.11): draft → active ⇄ paused → retired —
   * no draft → paused/draft → retired, retired is terminal.
   */
  changeStatus(
    principal: PeoplePrincipal,
    kind: PeopleAggregateKind,
    input: StatusChangeInput,
  ): Promise<
    PeopleResult<
      DigitalHumanRecord | CharacterRecord | PersonaRecord | AiCreatorRecord
    >
  >;

  // ---- Reads (people.read) ----------------------------------------------
  listDigitalHumans(principal: PeoplePrincipal, limit?: number): Promise<PeopleResult<readonly DigitalHumanRecord[]>>;
  listCharacters(principal: PeoplePrincipal, limit?: number): Promise<PeopleResult<readonly CharacterRecord[]>>;
  listPersonas(principal: PeoplePrincipal, limit?: number): Promise<PeopleResult<readonly PersonaRecord[]>>;
  listAiCreators(principal: PeoplePrincipal, limit?: number): Promise<PeopleResult<readonly AiCreatorRecord[]>>;
  listProfiles(principal: PeoplePrincipal, limit?: number): Promise<PeopleResult<readonly CreatorProfileRecord[]>>;

  // ---- Publication-authored snapshot family (D2.16-3) --------------------
  /**
   * Mediated snapshot write. Idempotent by publication_version_id; on a NEW
   * version the previous current row is retired to 'unpublished' and the new
   * row becomes 'active'. History is never deleted. Caller org must match the
   * creator's org (server-side derivation; no client org authority).
   */
  upsertProfileSnapshot(input: ProfileSnapshotInput): Promise<PeopleResult<SnapshotOutcome>>;
  /**
   * publication.unpublished handling: current row → 'unpublished'; absent
   * profile → idempotent no-op; historical rows retained.
   */
  unpublishCurrentSnapshot(input: {
    orgId: string;
    aiCreatorId: string;
  }): Promise<PeopleResult<{ readonly kind: "retired" | "absent" }>>;
}
