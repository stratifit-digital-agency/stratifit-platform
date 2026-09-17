/**
 * Durable admin-audit adapter over @stratifit/database (Drizzle).
 *
 * Owns the `audit_log` table family (SERVICE_ARCHITECTURE section 11 line 364).
 * The append is a plain INSERT — no UPDATE path exists in this module, and the
 * database enforces append-only (INSERT+SELECT grants/policies only, migration
 * 0009). `transactionWriter()` produces the D2.4-1 transaction-scoped writer:
 * it runs the INSERT on the CALLER'S transaction connection (`tx`) and never
 * commits — the domain mutation's transaction owns commit/rollback.
 */
import { and, desc, asc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { auditLog, createDatabase, type Database } from "@stratifit/database";
import type {
  AuditAppendEntry,
  AuditEntry,
  AuditPage,
  AuditQuery,
  AuditRepository,
} from "./types";

export interface DrizzleAuditRepositoryDeps {
  /** Existing Drizzle database (Control composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
}

const toEntry = (row: typeof auditLog.$inferSelect): AuditEntry => ({
  id: row.id,
  actorId: row.actorId,
  action: row.action,
  subjectKind: row.subjectKind,
  subjectId: row.subjectId,
  organizationId: row.organizationId,
  correlationId: row.correlationId,
  causationId: row.causationId,
  payload: row.payload ?? {},
  occurredAt: row.occurredAt.toISOString(),
});

export const createDrizzleAuditRepository = (
  deps: DrizzleAuditRepositoryDeps = {},
): AuditRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);

  const insertWithin = async (tx: Database, entry: AuditAppendEntry) => {
    if (!entry.actorId || !entry.action || !entry.subjectKind || !entry.subjectId) {
      throw new Error("audit entry is missing required fields");
    }
    await tx.insert(auditLog).values({
      actorId: entry.actorId,
      action: entry.action,
      subjectKind: entry.subjectKind,
      subjectId: entry.subjectId,
      organizationId: entry.organizationId ?? null,
      correlationId: entry.correlationId ?? null,
      causationId: entry.causationId ?? null,
      payload: entry.payload ?? {},
    });
  };

  return {
    async append(entry) {
      await insertWithin(db, entry);
    },

    transactionWriter() {
      return {
        // D2.4-1: insert on the CALLER'S transaction connection — the same
        // connection as the domain mutation — so both commit or roll back
        // atomically. No independent transaction is opened here.
        appendWithin: (tx, entry) => insertWithin(tx, entry),
      };
    },

    async queryOrgAudit(query) {
      const direction = query.direction ?? "desc";
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions: SQL[] = [eq(auditLog.organizationId, query.organizationId)];
      if (query.action) conditions.push(eq(auditLog.action, query.action));
      if (query.subjectKind) conditions.push(eq(auditLog.subjectKind, query.subjectKind));
      if (query.subjectId) conditions.push(eq(auditLog.subjectId, query.subjectId));
      if (query.actorId) conditions.push(eq(auditLog.actorId, query.actorId));

      if (query.cursor) {
        // Cursor format: "<occurredAt ISO>|<id>". The OR pair makes the scan
        // stable when many rows share one occurred_at timestamp.
        const sep = query.cursor.lastIndexOf("|");
        const ts = new Date(query.cursor.slice(0, sep));
        const id = query.cursor.slice(sep + 1);
        if (!Number.isNaN(ts.getTime()) && id) {
          const timeCmp = direction === "desc" ? lt(auditLog.occurredAt, ts) : sql`${auditLog.occurredAt} > ${ts}`;
          const idCmp =
            direction === "desc"
              ? and(eq(auditLog.occurredAt, ts), lt(auditLog.id, id))
              : and(eq(auditLog.occurredAt, ts), sql`${auditLog.id} > ${id}`);
          conditions.push(or(timeCmp!, idCmp!)!);
        }
      }

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(direction === "desc" ? desc(auditLog.occurredAt) : asc(auditLog.occurredAt), direction === "desc" ? desc(auditLog.id) : asc(auditLog.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        entries: page.map(toEntry),
        nextCursor: hasMore && last ? `${last.occurredAt.toISOString()}|${last.id}` : null,
      };
    },
  };
};
