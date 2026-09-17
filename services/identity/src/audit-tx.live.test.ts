import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLog,
  createDatabase,
  orgMemberships,
  operators,
  organizations,
} from "@stratifit/database";
import { createAdminAuditService, createDrizzleAuditRepository } from "@stratifit/admin-audit";
import { createDrizzleMembershipRepository } from "./repository";

/**
 * Live D2.4-1 proof (approved Stage 2.4): a security-critical membership
 * mutation and its audit record commit in the SAME database transaction via
 * MembershipRepository.runInTransaction — a failing audit INSERT rolls back
 * the membership mutation, and a committed mutation always carries its audit
 * row. Lives here (not in admin-audit) because the mutating aggregate is the
 * membership; identity is composition-wise ALLOWED to depend on admin-audit
 * (the sanctioned append path), never the reverse.
 *
 * Gated on the git-ignored root .env (same pattern as the other live suites);
 * unit suites with fakes cover the semantics in clean checkouts/CI.
 */
const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const databaseUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;

const db = hasEnv && databaseUrl ? createDatabase(databaseUrl) : null;
const raw = hasEnv && databaseUrl ? postgres(databaseUrl, { prepare: false, max: 1 }) : null;

const repo = db
  ? createDrizzleMembershipRepository({
      db,
      auditWriter: (() => {
        // Same adapter as the Control composition root: identity's D4 seam
        // shape (targetType/targetId/metadata) maps to admin-audit's canonical
        // entry (subjectKind/subjectId/payload) at the writer boundary; the
        // writer executes on the transaction connection handed to it.
        const writer = createAdminAuditService({
          repository: createDrizzleAuditRepository({ db: db! }),
        }).transactionWriter();
        return {
          appendWithin: (tx, entry) =>
            writer.appendWithin(tx, {
              actorId: entry.actorId,
              action: entry.action,
              subjectKind: entry.targetType,
              subjectId: entry.targetId,
              organizationId: entry.organizationId ?? null,
              correlationId: entry.correlationId ?? null,
              causationId: entry.causationId ?? null,
              payload: entry.metadata ?? {},
            }),
        };
      })(),
    })
  : null;

const SUFFIX = randomUUID().slice(0, 8);
const createdOperatorIds: string[] = [];

describe.skipIf(!db || !repo || !raw)("membership + audit same-transaction (live, D2.4-1, gated)", () => {
  let orgId = "";

  beforeAll(async () => {
    if (!db) return;
    const [org] = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (!org) throw new Error("no organization row");
    orgId = org.id;
  });

  const makeOperator = async (): Promise<string> => {
    if (!db) throw new Error("db unavailable");
    const subject = `it-auditx-${SUFFIX}-${createdOperatorIds.length}`;
    const [row] = await db
      .insert(operators)
      .values({
        orgId,
        authSubjectRef: subject,
        email: `${subject}@example.test`,
        displayName: "Audit Tx Probe",
        roles: ["viewer"],
      })
      .returning({ id: operators.id });
    if (!row) throw new Error("operator insert returned no row");
    createdOperatorIds.push(row.id);
    return row.id;
  };

  it("commits membership mutation and audit record in the SAME transaction", async () => {
    if (!db || !repo) return;
    const actorId = await makeOperator();
    const correlation = `tx-success-${SUFFIX}`;

    const inserted = await repo.runInTransaction!(async (tx) => {
      const m = await tx.insertOrgMembership({
        operatorId: actorId,
        organizationId: orgId,
        role: "viewer",
        grantedBy: actorId,
      });
      // Identity seam shape; the auditWriter adapter maps it to the
      // admin-audit entry and INSERTs on THIS transaction connection.
      await tx.appendAudit({
        actorId,
        action: "membership.granted",
        targetType: "membership",
        targetId: m.id,
        organizationId: orgId,
        correlationId: correlation,
        metadata: { role: "viewer", probe: SUFFIX },
      });
      return m;
    });

    const [membershipRow] = await db
      .select({ id: orgMemberships.id })
      .from(orgMemberships)
      .where(eq(orgMemberships.id, inserted.id))
      .limit(1);
    expect(membershipRow?.id).toBe(inserted.id);

    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.correlationId, correlation))
      .limit(1);
    expect(auditRow?.action).toBe("membership.granted");
    expect(auditRow?.subjectId).toBe(inserted.id);
  });

  it("rolls back the membership mutation when the audit INSERT fails", async () => {
    if (!db || !repo) return;
    const actorId = await makeOperator();

    // The audit INSERT fails at the DB level (invalid uuid for subject_id),
    // which must roll back the preceding membership INSERT in the same tx:
    // a mutation cannot commit without its required audit record.
    await expect(
      repo.runInTransaction!(async (tx) => {
        const m = await tx.insertOrgMembership({
          operatorId: actorId,
          organizationId: orgId,
          role: "viewer",
          grantedBy: actorId,
        });
        await tx.appendAudit({
          actorId,
          action: "membership.granted",
          targetType: "membership",
          targetId: "not-a-uuid",
          organizationId: orgId,
        });
        return m;
      }),
    ).rejects.toBeDefined();

    const membershipRows = await db
      .select({ id: orgMemberships.id })
      .from(orgMemberships)
      .where(eq(orgMemberships.operatorId, actorId));
    expect(membershipRows).toHaveLength(0);

    const auditRows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.actorId, actorId));
    expect(auditRows).toHaveLength(0);
  });

  afterAll(async () => {
    // Clean probe operators; audit rows remain (append-only by design).
    if (db) {
      for (const id of createdOperatorIds) {
        await db.delete(orgMemberships).where(eq(orgMemberships.operatorId, id));
        await db.delete(operators).where(eq(operators.id, id));
      }
      try {
        const client = (db as unknown as { $client?: { end: (o?: object) => Promise<void> } })
          .$client;
        await client?.end({ timeout: 1 });
      } catch {
        /* best-effort teardown */
      }
    }
    await raw?.end({ timeout: 1 });
  });
});
