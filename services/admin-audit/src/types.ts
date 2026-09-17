/**
 * Admin-audit module types (Stage 2.4, Decision 4).
 *
 * The append entry shape is the durable mirror of the D4 seam in
 * services/identity (AuditAppend): actor, action, subject kind/id, org scope,
 * correlation set, and an opaque secret-free payload. `runInTransaction` is
 * the transaction-scoped persistence port (approved D2.4-1 Option A): the
 * caller supplies the SAME connection as the domain mutation so the audit
 * INSERT commits or rolls back atomically with it — admin-audit never opens a
 * second, independent transaction for same-transaction appends.
 */
import type { Database } from "@stratifit/database";

/** Target subject types known to Stage 2.4 producers (membership, team). */
export type AuditSubjectKind = "membership" | "team";

export interface AuditAppendEntry {
  /** Acting operator row id (opaque to admin-audit; no cross-module FK). */
  readonly actorId: string;
  readonly action: string;
  readonly subjectKind: AuditSubjectKind | (string & {});
  readonly subjectId: string;
  /** Org scope for D2.4-2 organization-scoped reads; null = platform-level. */
  readonly organizationId?: string | null;
  /** Correlation set per DATA_FLOW / EVENT_ARCHITECTURE observability. */
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  /** Opaque, secret-free before/after snapshot or command metadata. */
  readonly payload?: Record<string, unknown>;
}

/** The single sanctioned cross-module audit write path (Decision 4). */
export type AuditAppend = (entry: AuditAppendEntry) => Promise<void>;

/**
 * Transaction-scoped persistence port (D2.4-1 Option A). `appendWithin`
 * receives the CALLER'S transaction connection (`tx`) and MUST run the audit
 * INSERT on that same connection — never on an independent one — and MUST NOT
 * commit or roll back. Ownership of the transaction stays with the domain
 * mutation's repository, so a crash before COMMIT rolls back BOTH the domain
 * mutation and the audit row.
 */
export interface Transaction {
  appendWithin(tx: Database, entry: AuditAppendEntry): Promise<void>;
}

export type AuditSortDirection = "asc" | "desc";

export interface AuditQuery {
  readonly organizationId: string;
  readonly action?: string;
  readonly subjectKind?: string;
  readonly subjectId?: string;
  readonly actorId?: string;
  readonly direction?: AuditSortDirection;
  /** Opaque cursor = occurred_at ISO + id (stable against equal timestamps). */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AuditEntry {
  readonly id: string;
  readonly actorId: string;
  readonly action: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly organizationId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  readonly nextCursor: string | null;
}

/** Read-side port (D2.4-2): org-scoped, cursor-paginated, filtered. */
export interface AuditReadRepository {
  queryOrgAudit(query: AuditQuery): Promise<AuditPage>;
}

/** Write-side + transaction port implemented over the shared Drizzle pool. */
export interface AuditAppendRepository {
  /** Standalone append (own connection; used outside domain transactions). */
  append(entry: AuditAppendEntry): Promise<void>;
  /** The D2.4-1 transaction-scoped writer handed to domain repositories. */
  transactionWriter(): Transaction;
}

export type AuditRepository = AuditAppendRepository & AuditReadRepository;

/** Validation/error surface for append (fail-closed per Decision 4). */
export type AuditAppendErrorReason = "invalid_entry" | "append_failed";

export type AuditAppendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AuditAppendErrorReason; readonly message: string };
