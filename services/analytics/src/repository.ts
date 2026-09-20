/**
 * Drizzle repository adapter for the ANALYTICS INTAKE family (Stage 2.19).
 * Implements the AnalyticsRepository port from types.ts.
 *
 * IMMUTABLE by design (D2.19-A6): ONLY insertEventIfAbsent + the
 * fail-closed published-content resolver exist. There is no update, no
 * delete, and no read/query method — the DB grants enforce the same
 * (INSERT+SELECT only; live 42501 proofs).
 */
import { and, eq } from "drizzle-orm";
import { analyticsEvents, createDatabase, publicContent, type Database } from "@stratifit/database";
import type {
  AnalyticsEventRecord,
  AnalyticsRepository,
  NewAnalyticsEventRow,
} from "./types";

const toRecord = (row: typeof analyticsEvents.$inferSelect): AnalyticsEventRecord => ({
  id: row.id,
  eventType: row.eventType as AnalyticsEventRecord["eventType"],
  contentRef: row.contentRef ?? null,
  orgId: row.orgId ?? null,
  audienceUserId: row.audienceUserId ?? null,
  sessionHash: row.sessionHash,
  serverTs: row.serverTs,
  ingestEventId: row.ingestEventId,
});

const isUniqueViolation = (e: unknown): boolean => {
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && typeof cur === "object" && cur !== null; depth++) {
    if ((cur as { code?: string }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
};

export interface DrizzleAnalyticsRepositoryDeps {
  db?: Database;
  databaseUrl?: string;
}

export const createDrizzleAnalyticsRepository = (deps: DrizzleAnalyticsRepositoryDeps): AnalyticsRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  return {
    insertEventIfAbsent: async (input: NewAnalyticsEventRow): Promise<AnalyticsEventRecord | null> => {
      try {
        // Idempotent by UNIQUE(ingest_event_id): a replayed event inserts
        // NOTHING and returns null (no second row, no re-emission upstream).
        const [row] = await db
          .insert(analyticsEvents)
          .values({
            eventType: input.eventType,
            contentRef: input.contentRef,
            orgId: input.orgId,
            audienceUserId: input.audienceUserId,
            sessionHash: input.sessionHash,
            properties: input.properties,
            clientTs: input.clientTs,
            ingestEventId: input.ingestEventId,
          })
          .onConflictDoNothing({ target: analyticsEvents.ingestEventId })
          .returning();
        return row ? toRecord(row) : null;
      } catch (e) {
        // Lost race against a concurrent identical ingest_event_id: the
        // UNIQUE constraint is the backstop; surface as null (deduped).
        if (isUniqueViolation(e)) return null;
        throw e;
      }
    },
    findPublishedContentRef: async (
      contentRef: string,
    ): Promise<{ id: string; orgId: string } | null> => {
      const [row] = await db
        .select({ id: publicContent.id, orgId: publicContent.orgId })
        .from(publicContent)
        .where(and(eq(publicContent.id, contentRef), eq(publicContent.status, "published")))
        .limit(1);
      return row ?? null;
    },
  };
};
