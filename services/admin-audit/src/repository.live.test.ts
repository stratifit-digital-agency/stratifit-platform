import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { describe, expect, it, afterAll } from "vitest";
import { auditLog, createDatabase, operators, organizations } from "@stratifit/database";
import { createAdminAuditService, createDrizzleAuditRepository } from "./index";

/**
 * Live integration tests (gated on the git-ignored root .env, like the other
 * suites). Proves against the REAL remote database, as the runtime role:
 *   - append -> org-scoped read roundtrip with filters (D2.4-2);
 *   - UPDATE and DELETE on audit_log are DENIED (42501) — append-only by
 *     grant and by RLS policy (Decision 4).
 *
 * The D2.4-1 same-transaction proof (membership mutation + audit INSERT in
 * one transaction, success and rollback) lives in services/identity — the
 * mutating aggregate is the membership, and identity is the module allowed
 * to compose admin-audit (never the reverse). See
 * services/identity/src/audit-tx.live.test.ts.
 *
 * Audit rows created here are intentionally NOT deleted: audit_log is
 * append-only by design (no DELETE grant/policy). They are inert probe facts.
 */
const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const databaseUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;

const d = hasEnv && databaseUrl ? describe : describe.skip;

d("admin-audit live (gated, runtime role)", () => {
  const db = createDatabase(databaseUrl as string);
  const raw = postgres(databaseUrl as string, { prepare: false, max: 1 });
  const audit = createAdminAuditService({
    repository: createDrizzleAuditRepository({ db }),
  });

  const ORG_SLUG = "stratifit";
  let orgId = "";
  const createdOperators: string[] = [];

  const makeOperator = async (): Promise<string> => {
    const subject = `it-audit-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const [row] = await db
      .insert(operators)
      .values({
        orgId,
        authSubjectRef: subject,
        email: `${subject}@example.test`,
        displayName: "Audit Probe",
        roles: ["viewer"],
      })
      .returning({ id: operators.id });
    if (!row) throw new Error("operator insert returned no row");
    createdOperators.push(row.id);
    return row.id;
  };

  it("appends and reads back an audit entry (org-scoped roundtrip, filters)", async () => {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, ORG_SLUG))
      .limit(1);
    if (!org) throw new Error("default organization 'stratifit' is not seeded");
    orgId = org.id;

    const actorId = await makeOperator();
    const subjectId = randomUUID();
    await audit.append({
      actorId,
      action: "team.created",
      subjectKind: "team",
      subjectId,
      organizationId: orgId,
      correlationId: `corr-${subjectId}`,
      payload: { slug: "probe-team" },
    });

    const page = await audit.queryOrgAudit({
      organizationId: orgId,
      action: "team.created",
      subjectId,
      limit: 10,
    });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.payload).toEqual({ slug: "probe-team" });
    expect(page.entries[0]!.correlationId).toBe(`corr-${subjectId}`);
    expect(page.entries[0]!.organizationId).toBe(orgId);
    expect(page.nextCursor).toBeNull();

    // A different filter must not match the probe entry.
    const miss = await audit.queryOrgAudit({ organizationId: orgId, action: "team.archived", subjectId });
    expect(miss.entries).toHaveLength(0);
  });

  it("DENIES UPDATE on audit_log for the runtime role (42501, append-only)", async () => {
    await expect(
      raw`update audit_log set action = 'tampered' where id = ${randomUUID()}`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("DENIES DELETE on audit_log for the runtime role (42501, append-only)", async () => {
    await expect(raw`delete from audit_log where id = ${randomUUID()}`).rejects.toMatchObject({
      code: "42501",
    });
  });

  afterAll(async () => {
    // Clean probe operators/memberships; audit rows remain (append-only).
    for (const id of createdOperators) {
      await db.delete(operators).where(eq(operators.id, id));
    }
    try {
      const client = (db as unknown as { $client?: { end: (o?: object) => Promise<void> } }).$client;
      await client?.end({ timeout: 1 });
    } catch {
      /* client teardown best-effort */
    }
    await raw.end({ timeout: 1 });
  });
});
