import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, orgMemberships, organizations, operators, teams } from "@stratifit/database";
import { eq } from "drizzle-orm";
import { createDrizzleMembershipRepository } from "./repository";

/**
 * Live integration suite for the membership repository (Stage 2.2).
 * Runs ONLY when a git-ignored root .env provides DATABASE_URL (same gating
 * pattern as repository.integration.test.ts); unit suites cover all service
 * semantics with fakes, so this file stays skipped in clean checkouts/CI.
 * Exercises real constraints:
 *  - CHECK org_memberships_scope_exactly_one / role-vs-scope (D-3 guarantee)
 *  - partial unique indexes (grant race + append-and-revoke history)
 *  - per-org team slug uniqueness
 * Cleanup removes only the rows this suite created (unique suffix per run).
 */
const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const databaseUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;
const db = databaseUrl ? createDatabase(databaseUrl) : null;
const repo = databaseUrl ? createDrizzleMembershipRepository({ db: db! }) : null;

const SUFFIX = randomUUID().slice(0, 8);
const created = {
  operatorIds: [] as string[],
  teamIds: [] as string[],
};

/** drizzle wraps the driver error; the CHECK name lives on the cause. */
const expectCheckViolation = async (p: Promise<unknown>, constraint: string) => {
  const error = await p.then(
    () => null,
    (e) => e as Error & { cause?: { message?: string } },
  );
  expect(error).not.toBeNull();
  expect(`${error?.message ?? ""} ${error?.cause?.message ?? ""}`).toContain(constraint);
};

describe.skipIf(!db || !repo)("drizzle membership repository (live, gated)", () => {
  afterAll(async () => {
    if (!db) return;
    for (const id of created.operatorIds) {
      await db.delete(orgMemberships).where(eq(orgMemberships.operatorId, id));
      await db.delete(operators).where(eq(operators.id, id));
    }
    for (const id of created.teamIds) await db.delete(teams).where(eq(teams.id, id));
  });

  it("enforces D-3 structurally: a team row cannot carry a role", async () => {
    if (!db || !repo) return;
    const [org] = await db.select().from(organizations).limit(1);
    if (!org) throw new Error("no organization row");
    const team = await repo.insertTeam({ orgId: org.id, slug: `t-${SUFFIX}`, name: "Probe" });
    created.teamIds.push(team.id);
    const [op] = await db
      .insert(operators)
      .values({ orgId: org.id, authSubjectRef: `it-${SUFFIX}`, email: `it-${SUFFIX}@stratifit.test`, status: "active" })
      .returning({ id: operators.id });
    if (!op) throw new Error("operator insert returned no row");
    created.operatorIds.push(op.id);

    // role on a team-scoped row must violate the CHECK
    await expectCheckViolation(
      db.insert(orgMemberships).values({ operatorId: op.id, teamId: team.id, role: "viewer" }),
      "org_memberships_team_role_forbidden_check",
    );

    // org row without a role must violate the CHECK
    await expectCheckViolation(
      db.insert(orgMemberships).values({ operatorId: op.id, organizationId: org.id, role: null }),
      "org_memberships_org_role_required_check",
    );

    // both scopes set must violate exactly-one
    await expectCheckViolation(
      db.insert(orgMemberships).values({ operatorId: op.id, organizationId: org.id, teamId: team.id, role: "viewer" }),
      "org_memberships_scope_exactly_one_check",
    );
  });

  it("serializes concurrent grants via the partial unique index (append-and-revoke)", async () => {
    if (!db || !repo) return;
    const [org] = await db.select().from(organizations).limit(1);
    if (!org) throw new Error("no organization row");
    const [op] = await db
      .insert(operators)
      .values({ orgId: org.id, authSubjectRef: `it2-${SUFFIX}`, email: `it2-${SUFFIX}@stratifit.test`, status: "active" })
      .returning({ id: operators.id });
    if (!op) throw new Error("operator insert returned no row");
    created.operatorIds.push(op.id);

    const results = await Promise.allSettled([
      repo.insertOrgMembership({ operatorId: op.id, organizationId: org.id, role: "viewer" }),
      repo.insertOrgMembership({ operatorId: op.id, organizationId: org.id, role: "viewer" }),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners.length).toBe(1); // race produces exactly one active grant

    // revoke -> history preserved -> re-grant inserts a NEW row
    const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof repo.insertOrgMembership>>>).value;
    await repo.updateMembershipStatus(winner.id, "revoked", new Date());
    const reg = await repo.insertOrgMembership({ operatorId: op.id, organizationId: org.id, role: "viewer" });
    expect(reg.id).not.toBe(winner.id);
    const history = await repo.listMembershipsForOrg(org.id, true);
    const mine = history.filter((m) => m.operatorId === op.id);
    expect(mine.map((m) => m.status).sort()).toEqual(["active", "revoked"]);
  });

  it("rejects duplicate per-org team slugs", async () => {
    if (!db || !repo) return;
    const [org] = await db.select().from(organizations).limit(1);
    if (!org) throw new Error("no organization row");
    await repo.insertTeam({ orgId: org.id, slug: `dup-${SUFFIX}`, name: "A" });
    created.teamIds.push((await repo.findTeamBySlug(org.id, `dup-${SUFFIX}`))!.id);
    await expect(repo.insertTeam({ orgId: org.id, slug: `dup-${SUFFIX}`, name: "B" })).rejects.toThrow();
  });
});
