/**
 * Admin-audit service (Stage 2.4, Decision 4).
 *
 * `admin-audit.append` is the SOLE sanctioned cross-module audit write path
 * (SERVICE_ARCHITECTURE section 22 OQ10). Appends are validated and
 * fail-closed: an invalid entry throws rather than silently dropping the
 * record. Reads are org-scoped (D2.4-2) and capability-gated at the BFF
 * (`audit.read`) — the service trusts the caller to present an authorized org
 * scope, exactly like the membership service.
 */
import type {
  AuditAppendEntry,
  AuditAppendErrorReason,
  AuditEntry,
  AuditPage,
  AuditQuery,
  AuditRepository,
  Transaction,
} from "./types";

export interface AdminAuditServiceDeps {
  repository: AuditRepository;
}

export interface AdminAuditService {
  /** Validated append (fail-closed). Use `transactionWriter` inside domain transactions. */
  append(entry: AuditAppendEntry): Promise<void>;
  /** D2.4-1 transaction-scoped writer for domain repositories (never commits). */
  transactionWriter(): Transaction;
  /** Org-scoped, filtered, cursor-paginated audit trail (D2.4-2). */
  queryOrgAudit(query: AuditQuery): Promise<AuditPage>;
}

export type AuditQueryErrorReason = "invalid_query";

export const createAdminAuditService = (deps: AdminAuditServiceDeps): AdminAuditService => {
  const repo = deps.repository;

  const validateAppend = (entry: AuditAppendEntry): AuditAppendErrorReason | null => {
    if (!entry.actorId || !entry.action || !entry.subjectKind || !entry.subjectId) {
      return "invalid_entry";
    }
    if (typeof entry.action !== "string" || entry.action.length === 0 || entry.action.length > 200) {
      return "invalid_entry";
    }
    if (entry.payload !== undefined && (typeof entry.payload !== "object" || Array.isArray(entry.payload))) {
      return "invalid_entry";
    }
    return null;
  };

  return {
    async append(entry) {
      const failure = validateAppend(entry);
      if (failure) throw new AuditAppendRejectedError(failure, "audit entry is invalid (fail-closed: nothing was appended)");
      await repo.append(entry);
    },

    transactionWriter(): Transaction {
      return repo.transactionWriter();
    },

    async queryOrgAudit(query) {
      if (!query.organizationId) {
        throw new AuditQueryRejectedError("invalid_query", "organizationId is required");
      }
      if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200)) {
        throw new AuditQueryRejectedError("invalid_query", "limit must be an integer between 1 and 200");
      }
      return repo.queryOrgAudit(query);
    },
  };
};

export class AuditAppendRejectedError extends Error {
  constructor(
    public readonly reason: AuditAppendErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "AuditAppendRejectedError";
  }
}

export class AuditQueryRejectedError extends Error {
  constructor(
    public readonly reason: AuditQueryErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "AuditQueryRejectedError";
  }
}
