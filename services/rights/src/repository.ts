/**
 * Drizzle repository adapter for the RIGHTS family (Stage 2.21).
 * Implements the RightsRepository port from types.ts, mirroring the
 * services/people + services/creative adapter conventions:
 *
 *  - `Database` (postgres.js via Drizzle) typed pool shared from the
 *    composition root (or built from a URL);
 *  - `mutationsFor` returns the SAME mutation shapes over either the shared
 *    pool or an open transaction connection; `appendAudit` REQUIRES the
 *    injected auditWriter (D2.4-1 seam) so a mutation, its status-event row,
 *    and its audit record commit atomically — a rollback removes all three;
 *  - findSubjectRef: the narrow read-only subject-integrity seam over the
 *    EXISTING subject tables (digital_humans/characters/personas/assets/
 *    productions) — no behavior change to any owning context (D2.21-2);
 *  - NO delete paths and NO core-field update paths exist (D2.21-6).
 */
import { and, desc, eq } from "drizzle-orm";
import {
  aiCreators,
  assets,
  characters,
  createDatabase,
  digitalHumans,
  personas,
  productions,
  rightsGrants,
  rightsOwners,
  rightsStatusEvents,
  type Database,
} from "@stratifit/database";
import type {
  GrantStatus,
  OwnerKind,
  OwnerVerificationStatus,
  RightsAuditWriter,
  RightsGrantRecord,
  RightsOwnerRecord,
  RightsRepository,
  RightsStatusEventRecord,
  RightsSubjectKind,
  RightsTransaction,
  RightsScope,
  RightsPlatform,
} from "./types";

const asStatus = (v: string): GrantStatus => v as GrantStatus;
const asVerification = (v: string): OwnerVerificationStatus => v as OwnerVerificationStatus;
const asSubjectKind = (v: string): RightsSubjectKind => v as RightsSubjectKind;
const asScope = (v: string): RightsScope => v as RightsScope;

export interface DrizzleRightsRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /** D2.4-1 seam: same-transaction audit writer (composition-root mapped). */
  auditWriter?: RightsAuditWriter;
}

export const createDrizzleRightsRepository = (deps: DrizzleRightsRepositoryDeps): RightsRepository => {
  const exec: Database = deps.db ?? createDatabase(deps.databaseUrl as string);

  const mutationsFor = (
    conn: Database,
  ): Omit<RightsTransaction, "appendAudit"> & {
    appendAudit: (entry: Parameters<RightsAuditWriter["appendWithin"]>[1]) => Promise<void>;
  } => {
    const appendAudit = (entry: Parameters<RightsAuditWriter["appendWithin"]>[1]) => {
      if (!deps.auditWriter) {
        throw new Error("rights audit writer not configured; mutations are not available in read-only compositions");
      }
      return deps.auditWriter.appendWithin(conn, entry);
    };

    return {
      findOwnerById: async (id) => {
        const [row] = await conn.select().from(rightsOwners).where(eq(rightsOwners.id, id)).limit(1);
        return row ? { ...row, kind: row.kind as OwnerKind, verificationStatus: asVerification(row.verificationStatus) } : null;
      },
      findGrantById: async (id) => {
        const [row] = await conn.select().from(rightsGrants).where(eq(rightsGrants.id, id)).limit(1);
        return row ? mapGrant(row) : null;
      },
      findSubjectRef: async (subjectKind, subjectId) => {
        switch (subjectKind) {
          case "digital_human": {
            const [row] = await conn
              .select({ id: digitalHumans.id, orgId: digitalHumans.orgId, status: digitalHumans.status })
              .from(digitalHumans)
              .where(eq(digitalHumans.id, subjectId))
              .limit(1);
            return row ?? null;
          }
          case "character": {
            const [row] = await conn
              .select({ id: characters.id, orgId: characters.orgId, status: characters.status })
              .from(characters)
              .where(eq(characters.id, subjectId))
              .limit(1);
            return row ?? null;
          }
          case "persona": {
            const [row] = await conn
              .select({ id: personas.id, orgId: personas.orgId, status: personas.status })
              .from(personas)
              .where(eq(personas.id, subjectId))
              .limit(1);
            return row ?? null;
          }
          case "asset": {
            const [row] = await conn
              .select({ id: assets.id, orgId: assets.orgId, status: assets.approvalState })
              .from(assets)
              .where(eq(assets.id, subjectId))
              .limit(1);
            return row ?? null;
          }
          case "production": {
            const [row] = await conn
              .select({ id: productions.id, orgId: productions.orgId, status: productions.status })
              .from(productions)
              .where(eq(productions.id, subjectId))
              .limit(1);
            return row ?? null;
          }
          default:
            return null;
        }
      },
      insertOwner: async (input) => {
        const [row] = await conn
          .insert(rightsOwners)
          .values({
            orgId: input.orgId,
            kind: input.kind,
            displayName: input.displayName,
            contactRef: input.contactRef,
          })
          .returning();
        return {
          ...row!,
          kind: row!.kind as OwnerKind,
          verificationStatus: asVerification(row!.verificationStatus),
        };
      },
      setOwnerVerificationStatus: async (id, status) => {
        const [row] = await conn
          .update(rightsOwners)
          .set({ verificationStatus: status, updatedAt: new Date() })
          .where(eq(rightsOwners.id, id))
          .returning();
        return row
          ? { ...row, kind: row.kind as OwnerKind, verificationStatus: asVerification(row.verificationStatus) }
          : null;
      },
      insertGrant: async (input) => {
        const [row] = await conn
          .insert(rightsGrants)
          .values({
            orgId: input.orgId,
            ownerId: input.ownerId,
            subjectKind: input.subjectKind,
            subjectId: input.subjectId,
            scope: input.scope,
            platforms: [...input.platforms],
            territories: [...input.territories],
            startsAt: input.startsAt,
            expiresAt: input.expiresAt,
            status: input.status,
            grantedBy: input.grantedBy,
            evidenceRefs: [...input.evidenceRefs],
          })
          .returning();
        return mapGrant(row!);
      },
      setGrantStatus: async (id, status) => {
        const [row] = await conn
          .update(rightsGrants)
          .set({ status, updatedAt: new Date() })
          .where(eq(rightsGrants.id, id))
          .returning();
        return row ? mapGrant(row) : null;
      },
      insertStatusEvent: async (input) => {
        const [row] = await conn
          .insert(rightsStatusEvents)
          .values({
            orgId: input.orgId,
            grantId: input.grantId,
            fromStatus: input.fromStatus,
            toStatus: input.toStatus,
            reason: input.reason,
            actorId: input.actorId,
          })
          .returning();
        return {
          ...row!,
          fromStatus: asStatus(row!.fromStatus),
          toStatus: asStatus(row!.toStatus),
        };
      },
      appendAudit,
    };
  };

  const mapGrant = (row: typeof rightsGrants.$inferSelect): RightsGrantRecord => ({
    ...row,
    subjectKind: asSubjectKind(row.subjectKind),
    scope: asScope(row.scope),
    platforms: row.platforms as RightsPlatform[],
    status: asStatus(row.status),
  });

  const direct = mutationsFor(exec);

  return {
    // Transaction-scoped mutations (D2.4-1): the service always uses this so
    // a mutation can never commit without its status-event + audit rows.
    runInTransaction: async <T>(work: (tx: RightsTransaction) => Promise<T>): Promise<T> =>
      exec.transaction(async (trx) => work(mutationsFor(trx as unknown as Database))),

    // -----------------------------------------------------------------
    // Reads (pool-level, no audit)
    // -----------------------------------------------------------------
    findOwnerById: direct.findOwnerById,
    listOwners: (orgId, limit) =>
      exec
        .select()
        .from(rightsOwners)
        .where(eq(rightsOwners.orgId, orgId))
        .orderBy(desc(rightsOwners.createdAt))
        .limit(limit)
        .then((rows) =>
          rows.map((r) => ({ ...r, kind: r.kind as OwnerKind, verificationStatus: asVerification(r.verificationStatus) })),
        ),
    setOwnerVerificationStatus: direct.setOwnerVerificationStatus,
    findGrantById: direct.findGrantById,
    findGrantBySubject: async (orgId, subjectKind, subjectId, scope) => {
      const rows = await exec
        .select()
        .from(rightsGrants)
        .where(
          and(
            eq(rightsGrants.orgId, orgId),
            eq(rightsGrants.subjectKind, subjectKind),
            eq(rightsGrants.subjectId, subjectId),
            eq(rightsGrants.scope, scope),
          ),
        );
      return rows.map(mapGrant);
    },
    listGrants: (orgId, limit) =>
      exec
        .select()
        .from(rightsGrants)
        .where(eq(rightsGrants.orgId, orgId))
        .orderBy(desc(rightsGrants.createdAt))
        .limit(limit)
        .then((rows) => rows.map(mapGrant)),
    listStatusEvents: async (grantId) => {
      const rows = await exec
        .select()
        .from(rightsStatusEvents)
        .where(eq(rightsStatusEvents.grantId, grantId))
        .orderBy(desc(rightsStatusEvents.createdAt));
      return rows.map((r) => ({ ...r, fromStatus: asStatus(r.fromStatus), toStatus: asStatus(r.toStatus) }));
    },
    setStatusEvent: async ({ event }) =>
      direct.insertStatusEvent({
        orgId: event.orgId,
        grantId: event.grantId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reason: event.reason,
        actorId: event.actorId,
      }),

    // -----------------------------------------------------------------
    // Direct mutations (test-only sequential fallback)
    // -----------------------------------------------------------------
    insertOwner: direct.insertOwner,
    insertGrant: direct.insertGrant,
    setGrantStatus: direct.setGrantStatus,
    insertStatusEvent: direct.insertStatusEvent,
  };
};
