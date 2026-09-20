/**
 * Drizzle repository adapter for the PEOPLE CHAIN aggregates (Stage 2.16).
 * Implements the PeopleRepository port from types.ts, mirroring the
 * services/audience + services/production-engine adapter conventions:
 *
 *  - `Database` (postgres.js via Drizzle) typed pool shared from the
 *    composition root (or built from a URL);
 *  - `mutationsFor` returns the SAME mutation shapes over either the shared
 *    pool or an open transaction connection; `appendAudit` REQUIRES the
 *    injected auditWriter (D2.4-1 seam) so a mutation and its audit record
 *    commit atomically — a rollback removes both;
 *  - runInTransaction exposes the SAME transaction connection to the domain
 *    mutations and the audit writer (D2.4-1 seam);
 *  - creator_profiles: snapshot family — insert + retire + status set only.
 *    There is deliberately NO update of snapshot content fields and NO delete
 *    path (D2.16-3: history is immutable).
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  aiCreators,
  characters,
  createDatabase,
  creatorProfiles,
  digitalHumans,
  personas,
  publications,
  publicationVersions,
  type Database,
} from "@stratifit/database";
import type {
  AiCreatorRecord,
  ChainStatus,
  CharacterRecord,
  CreatorProfileRecord,
  DigitalHumanRecord,
  PeopleAuditWriter,
  PeopleRepository,
  PeopleTransaction,
  PersonaRecord,
  ProfileStatus,
} from "./types";

const asChain = (v: string): ChainStatus => v as ChainStatus;
const asProfile = (v: string): ProfileStatus => v as ProfileStatus;

export interface DrizzlePeopleRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /** D2.4-1 seam: same-transaction audit writer (composition-root mapped). */
  auditWriter?: PeopleAuditWriter;
}

export const createDrizzlePeopleRepository = (deps: DrizzlePeopleRepositoryDeps): PeopleRepository => {
  const exec: Database = deps.db ?? createDatabase(deps.databaseUrl as string);

  // -----------------------------------------------------------------------
  // Mutation scope: direct (pool) or transactional. `mutationsFor` returns
  // the SAME function shapes over either the shared pool or an open
  // transaction connection, plus appendAudit which REQUIRES the audit
  // writer (mirror of the audience adapter: mutations are not available in
  // compositions without an audit writer).
  // -----------------------------------------------------------------------
  const mutationsFor = (conn: Database): Omit<PeopleTransaction, "appendAudit"> & { appendAudit: (entry: Parameters<PeopleAuditWriter["appendWithin"]>[1]) => Promise<void> } => {
    const appendAudit = (entry: Parameters<PeopleAuditWriter["appendWithin"]>[1]) => {
      if (!deps.auditWriter) {
        throw new Error("people audit writer not configured; mutations are not available in read-only compositions");
      }
      return deps.auditWriter.appendWithin(conn, entry);
    };

    return {
      // ---------------------------------------------------------------
      // digital_humans
      // ---------------------------------------------------------------
      insertDigitalHuman: async (input) => {
        const [row] = await conn
          .insert(digitalHumans)
          .values({
            orgId: input.orgId,
            name: input.name,
            appearanceRefs: [...input.appearanceRefs],
            baseModelVersionRef: input.baseModelVersionRef,
            baseWorkflowVersionRef: input.baseWorkflowVersionRef,
          })
          .returning();
        return { ...row!, appearanceRefs: row!.appearanceRefs, status: asChain(row!.status) };
      },
      findDigitalHumanById: async (id) => {
        const [row] = await conn.select().from(digitalHumans).where(eq(digitalHumans.id, id)).limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      setDigitalHumanStatus: async (id, status) => {
        const [row] = await conn
          .update(digitalHumans)
          .set({ status, updatedAt: new Date() })
          .where(eq(digitalHumans.id, id))
          .returning();
        return row ? { ...row, status: asChain(row.status) } : null;
      },

      // ---------------------------------------------------------------
      // characters
      // ---------------------------------------------------------------
      insertCharacter: async (input) => {
        const [row] = await conn
          .insert(characters)
          .values({
            orgId: input.orgId,
            digitalHumanId: input.digitalHumanId,
            name: input.name,
            bio: input.bio,
            visualRefs: [...input.visualRefs],
          })
          .returning();
        return { ...row!, visualRefs: row!.visualRefs, status: asChain(row!.status) };
      },
      findCharacterById: async (id) => {
        const [row] = await conn.select().from(characters).where(eq(characters.id, id)).limit(1);
        return row ? { ...row, status: asChain(row.status) } : null;
      },
      setCharacterStatus: async (id, status) => {
        const [row] = await conn
          .update(characters)
          .set({ status, updatedAt: new Date() })
          .where(eq(characters.id, id))
          .returning();
        return row ? { ...row, status: asChain(row.status) } : null;
      },

      // ---------------------------------------------------------------
      // personas
      // ---------------------------------------------------------------
      insertPersona: async (input) => {
        const [row] = await conn
          .insert(personas)
          .values({
            orgId: input.orgId,
            characterId: input.characterId,
            name: input.name,
            personality: input.personality,
            interests: [...input.interests],
            capabilities: [...input.capabilities],
            languages: [...input.languages],
            behaviorConfig: input.behaviorConfig,
          })
          .returning();
        return {
          ...row!,
          interests: row!.interests,
          capabilities: row!.capabilities,
          languages: row!.languages,
          behaviorConfig: row!.behaviorConfig,
          status: asChain(row!.status),
        };
      },
      findPersonaById: async (id) => {
        const [row] = await conn.select().from(personas).where(eq(personas.id, id)).limit(1);
        return row
          ? {
              ...row,
              interests: row.interests,
              capabilities: row.capabilities,
              languages: row.languages,
              behaviorConfig: row.behaviorConfig,
              status: asChain(row.status),
            }
          : null;
      },
      setPersonaStatus: async (id, status) => {
        const [row] = await conn
          .update(personas)
          .set({ status, updatedAt: new Date() })
          .where(eq(personas.id, id))
          .returning();
        return row
          ? {
              ...row,
              interests: row.interests,
              capabilities: row.capabilities,
              languages: row.languages,
              behaviorConfig: row.behaviorConfig,
              status: asChain(row.status),
            }
          : null;
      },

      // ---------------------------------------------------------------
      // ai_creators
      // ---------------------------------------------------------------
      insertAiCreator: async (input) => {
        const [row] = await conn
          .insert(aiCreators)
          .values({
            orgId: input.orgId,
            personaId: input.personaId,
            handle: input.handle,
            displayName: input.displayName,
            capabilities: [...input.capabilities],
            contentCategories: [...input.contentCategories],
            communicationConfig: input.communicationConfig,
          })
          .returning();
        return {
          ...row!,
          capabilities: row!.capabilities,
          contentCategories: row!.contentCategories,
          communicationConfig: row!.communicationConfig,
          status: asChain(row!.status),
        };
      },
      findAiCreatorById: async (id) => {
        const [row] = await conn.select().from(aiCreators).where(eq(aiCreators.id, id)).limit(1);
        return row
          ? {
              ...row,
              capabilities: row.capabilities,
              contentCategories: row.contentCategories,
              communicationConfig: row.communicationConfig,
              status: asChain(row.status),
            }
          : null;
      },
      findAiCreatorByHandle: async (orgId, handle) => {
        const [row] = await conn
          .select()
          .from(aiCreators)
          .where(and(eq(aiCreators.orgId, orgId), eq(aiCreators.handle, handle)))
          .limit(1);
        return row
          ? {
              ...row,
              capabilities: row.capabilities,
              contentCategories: row.contentCategories,
              communicationConfig: row.communicationConfig,
              status: asChain(row.status),
            }
          : null;
      },
      setAiCreatorStatus: async (id, status) => {
        const [row] = await conn
          .update(aiCreators)
          .set({ status, updatedAt: new Date() })
          .where(eq(aiCreators.id, id))
          .returning();
        return row
          ? {
              ...row,
              capabilities: row.capabilities,
              contentCategories: row.contentCategories,
              communicationConfig: row.communicationConfig,
              status: asChain(row.status),
            }
          : null;
      },

      // ---------------------------------------------------------------
      // creator_profiles — publication-authored snapshot family (D2.16-3)
      // ---------------------------------------------------------------
      findCurrentProfile: async (orgId, aiCreatorId) => {
        const [row] = await conn
          .select()
          .from(creatorProfiles)
          .where(and(eq(creatorProfiles.orgId, orgId), eq(creatorProfiles.aiCreatorId, aiCreatorId)))
          .limit(1);
        return row ? { ...row, status: asProfile(row.status) } : null;
      },
      findProfileByVersionId: async (publicationVersionId) => {
        const [row] = await conn
          .select()
          .from(creatorProfiles)
          .where(eq(creatorProfiles.publicationVersionId, publicationVersionId))
          .limit(1);
        return row ? { ...row, status: asProfile(row.status) } : null;
      },
      insertProfile: async (input) => {
        const [row] = await conn
          .insert(creatorProfiles)
          .values({
            orgId: input.orgId,
            aiCreatorId: input.aiCreatorId,
            publicationId: input.publicationId,
            publicationVersionId: input.publicationVersionId,
            handle: input.handle,
            displayName: input.displayName,
            bio: input.bio,
            personalitySnapshot: input.personalitySnapshot,
            interestsSnapshot: [...input.interestsSnapshot],
            avatarRef: input.avatarRef,
            posterRef: input.posterRef,
            messagingEnabled: input.messagingEnabled,
            status: "active" satisfies ProfileStatus,
          })
          .returning();
        return { ...row!, status: asProfile(row!.status) };
      },
      /** Retire to 'unpublished' — never a delete; history is retained. */
      retireProfile: async (profileId) => {
        const [row] = await conn
          .update(creatorProfiles)
          .set({ status: "unpublished" satisfies ProfileStatus, updatedAt: new Date() })
          .where(eq(creatorProfiles.id, profileId))
          .returning();
        return { ...row!, status: asProfile(row!.status) };
      },

      // Narrow mediation-only read (authorized freeze fix 2): the orgs owning
      // the publication version AND its parent publication. Read-only over the
      // two org_id columns — no publication mutation surface is exposed.
      findPublicationVersionOrg: async (publicationId, publicationVersionId) => {
        const [row] = await conn
          .select({ versionOrgId: publicationVersions.orgId, publicationOrgId: publications.orgId })
          .from(publicationVersions)
          .innerJoin(publications, eq(publicationVersions.publicationId, publications.id))
          .where(and(eq(publicationVersions.id, publicationVersionId), eq(publicationVersions.publicationId, publicationId)))
          .limit(1);
        return row ?? null;
      },

      appendAudit,
    };
  };

  const direct = mutationsFor(exec);

  return {
    // Transaction-scoped mutations (D2.4-1): prefer runInTransaction — the
    // service uses it so a mutation can never commit without its audit row.
    runInTransaction: async <T>(work: (tx: PeopleTransaction) => Promise<T>): Promise<T> =>
      exec.transaction(async (trx) => work(mutationsFor(trx as unknown as Database))),

    // -----------------------------------------------------------------
    // Reads (pool-level, no audit)
    // -----------------------------------------------------------------
    findDigitalHumanById: direct.findDigitalHumanById,
    listDigitalHumans: (orgId, limit) =>
      exec
        .select()
        .from(digitalHumans)
        .where(eq(digitalHumans.orgId, orgId))
        .orderBy(desc(digitalHumans.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asChain(r.status) }))),
    findCharacterById: direct.findCharacterById,
    listCharacters: (orgId, limit) =>
      exec
        .select()
        .from(characters)
        .where(eq(characters.orgId, orgId))
        .orderBy(desc(characters.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asChain(r.status) }))),
    findPersonaById: direct.findPersonaById,
    listPersonas: (orgId, limit) =>
      exec
        .select()
        .from(personas)
        .where(eq(personas.orgId, orgId))
        .orderBy(desc(personas.createdAt))
        .limit(limit)
        .then((rows) =>
          rows.map((r) => ({
            ...r,
            interests: r.interests,
            capabilities: r.capabilities,
            languages: r.languages,
            behaviorConfig: r.behaviorConfig,
            status: asChain(r.status),
          })),
        ),
    findAiCreatorById: direct.findAiCreatorById,
    findAiCreatorByHandle: direct.findAiCreatorByHandle,
    listAiCreators: (orgId, limit) =>
      exec
        .select()
        .from(aiCreators)
        .where(eq(aiCreators.orgId, orgId))
        .orderBy(desc(aiCreators.createdAt))
        .limit(limit)
        .then((rows) =>
          rows.map((r) => ({
            ...r,
            capabilities: r.capabilities,
            contentCategories: r.contentCategories,
            communicationConfig: r.communicationConfig,
            status: asChain(r.status),
          })),
        ),
    findActiveProfileByHandle: async (handle) => {
      const [row] = await exec
        .select()
        .from(creatorProfiles)
        .where(and(eq(creatorProfiles.handle, handle), eq(creatorProfiles.status, "active")))
        .limit(1);
      return row ? { ...row, status: asProfile(row.status) } : null;
    },
    findActiveProfileByCreatorId: async (aiCreatorId) => {
      const [row] = await exec
        .select()
        .from(creatorProfiles)
        .where(and(eq(creatorProfiles.aiCreatorId, aiCreatorId), eq(creatorProfiles.status, "active")))
        .limit(1);
      return row ? { ...row, status: asProfile(row.status) } : null;
    },
    listActiveProfiles: (limit) =>
      exec
        .select()
        .from(creatorProfiles)
        .where(eq(creatorProfiles.status, "active"))
        .orderBy(asc(creatorProfiles.handle))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asProfile(r.status) }))),
    listProfilesByOrg: (orgId, limit) =>
      exec
        .select()
        .from(creatorProfiles)
        .where(eq(creatorProfiles.orgId, orgId))
        .orderBy(desc(creatorProfiles.updatedAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ ...r, status: asProfile(r.status) }))),

    // -----------------------------------------------------------------
    // Direct mutations (test-only sequential fallback, D2.4-1) — the
    // service prefers runInTransaction whenever the repository provides it.
    // -----------------------------------------------------------------
    insertDigitalHuman: direct.insertDigitalHuman,
    setDigitalHumanStatus: direct.setDigitalHumanStatus,
    insertCharacter: direct.insertCharacter,
    setCharacterStatus: direct.setCharacterStatus,
    insertPersona: direct.insertPersona,
    setPersonaStatus: direct.setPersonaStatus,
    insertAiCreator: direct.insertAiCreator,
    setAiCreatorStatus: direct.setAiCreatorStatus,
    findCurrentProfile: direct.findCurrentProfile,
    findProfileByVersionId: direct.findProfileByVersionId,
    insertProfile: direct.insertProfile,
    retireProfile: direct.retireProfile,
    setProfileStatus: async (profileId, status) => {
      const [row] = await exec
        .update(creatorProfiles)
        .set({ status, updatedAt: new Date() })
        .where(eq(creatorProfiles.id, profileId))
        .returning();
      return row ? { ...row, status: asProfile(row.status) } : null;
    },
  };
};
