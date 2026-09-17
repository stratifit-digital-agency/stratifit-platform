import { describe, expect, it, vi } from "vitest";
import { AuditAppendRejectedError, AuditQueryRejectedError, createAdminAuditService } from "./service";
import type { AuditAppendEntry, AuditPage, AuditRepository } from "./types";
import type { Database as Db } from "@stratifit/database";

/**
 * Unit tests for the Decision 4 audit service. The live security posture
 * (UPDATE/DELETE denial, RLS) is proven by repository.live.test.ts against the
 * real database; these tests cover service-level semantics with fakes.
 */

const validEntry = (over: Partial<AuditAppendEntry> = {}): AuditAppendEntry => ({
  actorId: "11111111-1111-1111-1111-111111111111",
  action: "membership.granted",
  subjectKind: "membership",
  subjectId: "22222222-2222-2222-2222-222222222222",
  organizationId: "33333333-3333-3333-3333-333333333333",
  payload: { role: "operator" },
  ...over,
});

const repoFake = (over: Partial<AuditRepository> = {}) => {
  const repo: AuditRepository = {
    append: vi.fn(async () => {}),
    transactionWriter: vi.fn(() => ({
      appendWithin: vi.fn(async (_tx: Db, _entry: AuditAppendEntry) => {}),
    })),
    queryOrgAudit: vi.fn(async (): Promise<AuditPage> => ({ entries: [], nextCursor: null })),
    ...over,
  };
  return repo;
};

describe("admin-audit append (fail-closed, Decision 4)", () => {
  it("appends a valid entry and returns void", async () => {
    const repo = repoFake();
    const svc = createAdminAuditService({ repository: repo });
    await expect(svc.append(validEntry())).resolves.toBeUndefined();
    expect(repo.append).toHaveBeenCalledOnce();
  });

  it("rejects entries missing required fields BEFORE any persistence (fail-closed)", async () => {
    const repo = repoFake();
    const svc = createAdminAuditService({ repository: repo });
    await expect(svc.append(validEntry({ actorId: "" }))).rejects.toBeInstanceOf(AuditAppendRejectedError);
    await expect(svc.append(validEntry({ action: "" }))).rejects.toBeInstanceOf(AuditAppendRejectedError);
    await expect(svc.append(validEntry({ subjectKind: "" }))).rejects.toBeInstanceOf(AuditAppendRejectedError);
    await expect(svc.append(validEntry({ subjectId: "" }))).rejects.toBeInstanceOf(AuditAppendRejectedError);
    expect(repo.append).not.toHaveBeenCalled();
  });

  it("rejects non-object payloads and overlong actions", async () => {
    const repo = repoFake();
    const svc = createAdminAuditService({ repository: repo });
    await expect(
      svc.append(validEntry({ payload: [1, 2] as unknown as Record<string, unknown> })),
    ).rejects.toBeInstanceOf(AuditAppendRejectedError);
    await expect(svc.append(validEntry({ action: "x".repeat(201) }))).rejects.toBeInstanceOf(AuditAppendRejectedError);
    expect(repo.append).not.toHaveBeenCalled();
  });
});

describe("admin-audit transaction writer (D2.4-1)", () => {
  it("exposes a transaction writer that delegates appendWithin to the repository", async () => {
    const appendWithin = vi.fn(async (_tx: Db, _entry: AuditAppendEntry) => {});
    const repo = repoFake({
      transactionWriter: vi.fn(() => ({ appendWithin })),
    });
    const svc = createAdminAuditService({ repository: repo });
    const writer = svc.transactionWriter();
    const tx = {} as Db;
    await writer.appendWithin(tx, validEntry());
    expect(appendWithin).toHaveBeenCalledOnce();
    expect(appendWithin.mock.calls[0]![0]).toBe(tx);
  });
});

describe("admin-audit org-scoped reads (D2.4-2)", () => {
  it("requires organizationId (invalid_query otherwise)", async () => {
    const repo = repoFake();
    const svc = createAdminAuditService({ repository: repo });
    await expect(svc.queryOrgAudit({ organizationId: "" })).rejects.toBeInstanceOf(AuditQueryRejectedError);
  });

  it("validates the limit range before querying", async () => {
    const repo = repoFake();
    const svc = createAdminAuditService({ repository: repo });
    await expect(svc.queryOrgAudit({ organizationId: "o", limit: 0 })).rejects.toBeInstanceOf(AuditQueryRejectedError);
    await expect(svc.queryOrgAudit({ organizationId: "o", limit: 201 })).rejects.toBeInstanceOf(AuditQueryRejectedError);
    await expect(svc.queryOrgAudit({ organizationId: "o", limit: 1.5 })).rejects.toBeInstanceOf(AuditQueryRejectedError);
    expect(repo.queryOrgAudit).not.toHaveBeenCalled();
  });

  it("passes org scope and filters through to the repository query", async () => {
    const repo = repoFake({
      queryOrgAudit: vi.fn(async (): Promise<AuditPage> => ({ entries: [], nextCursor: "c" })),
    });
    const svc = createAdminAuditService({ repository: repo });
    const page = await svc.queryOrgAudit({ organizationId: "org-a", action: "team.created", limit: 10 });
    expect(page.nextCursor).toBe("c");
    expect(repo.queryOrgAudit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a", action: "team.created", limit: 10 }),
    );
  });
});
