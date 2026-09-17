import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schemaExports from "./schema";
import {
  auditLog,
  audienceUsers,
  operators,
  organizations,
  orgMemberships,
  platformConfig,
  teams,
  verificationRequirements,
} from "./schema";

/**
 * Shape guards for the Stage 2.3 identity foundation + Stage 2.2 tenancy
 * expansion (approved decisions D1–D4, D-1..D-5). These lock the approved
 * structure; the domain-table guard keeps DOMAIN_MODEL families out until
 * their increments are separately approved.
 */

describe("identity foundation (Stage 2.3, approved shape)", () => {
  it("exposes exactly the identity/tenancy tables plus platform_config", () => {
    const exported = Object.keys(schemaExports).filter(
      (k) => !k.endsWith("Row") && !k.startsWith("New"),
    );
    expect(exported.sort()).toEqual(
      [
        "auditLog",
        "audienceUsers",
        "operators",
        "organizations",
        "orgMemberships",
        "platformConfig",
        "teams",
        "verificationRequirements",
      ].sort(),
    );
  });

  it("organizations: tenancy root with unique slug, no org_id", () => {
    const cols = Object.keys(getTableColumns(organizations)).sort();
    expect(cols).toEqual(["createdAt", "id", "name", "slug", "status", "updatedAt"]);
  });

  it("operators: org_id NOT NULL, unique auth subject, roles subset", () => {
    const c = getTableColumns(operators);
    expect(Object.keys(c).sort()).toEqual(
      ["authSubjectRef", "createdAt", "displayName", "email", "id", "orgId", "roles", "status", "updatedAt"],
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.authSubjectRef.notNull).toBe(true);
    expect(c.authSubjectRef.isUnique).toBe(true);
    expect(c.email.notNull).toBe(true);
  });

  it("audience_users: org_id NOT NULL, unique auth subject, email-verified mirror", () => {
    const c = getTableColumns(audienceUsers);
    expect(Object.keys(c).sort()).toEqual(
      ["authSubjectRef", "createdAt", "email", "emailVerified", "handle", "id", "orgId", "status", "updatedAt"],
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.authSubjectRef.isUnique).toBe(true);
    expect(c.emailVerified.notNull).toBe(true);
  });

  it("teams: assignment-only, org-scoped unique slug, no role column at all", () => {
    const c = getTableColumns(teams);
    expect(Object.keys(c).sort()).toEqual(
      ["createdAt", "id", "name", "orgId", "slug", "status", "updatedAt"],
    );
    expect(c.orgId.notNull).toBe(true);
    // D-3: teams carry no authorization surface whatsoever — no role column exists.
    expect("role" in c).toBe(false);
  });

  it("org_memberships: role NULL iff team-scoped (D-3 structural guarantee)", () => {
    const c = getTableColumns(orgMemberships);
    expect(Object.keys(c).sort()).toEqual(
      [
        "createdAt",
        "grantedAt",
        "grantedBy",
        "id",
        "operatorId",
        "organizationId",
        "revokedAt",
        "role",
        "status",
        "teamId",
        "updatedAt",
      ],
    );
    expect(c.operatorId.notNull).toBe(true);
    // Exactly one of org/team: both nullable at column level, CHECK enforces 1.
    expect(c.organizationId.notNull).toBe(false);
    expect(c.teamId.notNull).toBe(false);
    expect(c.role.notNull).toBe(false);
  });

  it("verification_requirements: platform-level (no org_id)", () => {
    const cols = Object.keys(getTableColumns(verificationRequirements)).sort();
    expect(cols).toEqual(["action", "createdAt", "requiredVerifications", "updatedAt"]);
  });

  it("every identity table is created with RLS enabled and no policies (deny-by-default)", () => {
    const migrationsDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const sqlText = files.map((f) => readFileSync(`${migrationsDir}/${f}`, "utf8")).join("\n");
    for (const table of [
      "organizations",
      "operators",
      "audience_users",
      "verification_requirements",
      "teams",
      "org_memberships",
    ]) {
      expect(sqlText).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    }
    // Stage 2.2 approved posture: RLS stays ENABLED everywhere; the ONLY
    // permitted policies are role-scoped to stratifit_runtime (the sanctioned
    // server path). anon/authenticated/service_role/PUBLIC remain denied.
    const policies = sqlText.match(/CREATE POLICY[^;]+;/g) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) expect(p).toContain("TO stratifit_runtime");
    expect(policies.join("\n")).not.toMatch(/TO (anon|authenticated|service_role|PUBLIC)\b/);
  });

  it("audit_log: append-only shape (no updatedAt column), nullable platform-level org_id", () => {
    const c = getTableColumns(auditLog);
    expect(Object.keys(c).sort()).toEqual(
      [
        "action",
        "actorId",
        "causationId",
        "correlationId",
        "id",
        "occurredAt",
        "organizationId",
        "payload",
        "subjectId",
        "subjectKind",
      ].sort(),
    );
    // Immutability at the schema level: no updated_at column exists.
    expect("updatedAt" in c).toBe(false);
    expect(c.organizationId.notNull).toBe(false);
  });

  it("platform_config remains exactly the approved foundational shape", () => {
    const cols = Object.keys(getTableColumns(platformConfig)).sort();
    expect(cols).toEqual(["createdAt", "id", "key", "updatedAt", "value"]);
  });
});

/**
 * Stage 2.2/2.4 approved least-privilege posture (Option A): runtime privileges
 * are EXPLICIT and allowlisted per table; no blanket default privilege exists.
 * These guards make accidental reintroduction fail clearly:
 *   - migration content: platform_config is revoked and never re-granted;
 *   - the static net effect of all GRANT/REVOKE statements to stratifit_runtime
 *     equals this per-table privilege map;
 *   - audit_log is append-only: INSERT + SELECT, NEVER UPDATE/DELETE
 *     (Decision 4 — no grant and no RLS policy may introduce them);
 *   - the stratifit_app default table privilege to stratifit_runtime is gone.
 */
const RUNTIME_PRIVILEGE_MAP: Record<string, readonly string[]> = {
  audience_users: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  operators: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  org_memberships: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  organizations: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  teams: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  verification_requirements: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  // Decision 4: append-only audit trail. UPDATE/DELETE must never be granted.
  audit_log: ["INSERT", "SELECT"],
};

describe("runtime privilege posture (approved least-privilege)", () => {
  const migrationsDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const migrationText = () =>
    readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(`${migrationsDir}/${f}`, "utf8"));

  const uncommented = (text: string) =>
    text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");

  it("migration 0006 revokes platform_config from stratifit_runtime", () => {
    const sql6 = readFileSync(`${migrationsDir}/0006_platform_config_grants.sql`, "utf8");
    expect(sql6).toContain(
      'REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_config FROM stratifit_runtime;',
    );
  });

  it("migration 0006 removes the blanket default table privilege (Option A)", () => {
    const sql6 = readFileSync(`${migrationsDir}/0006_platform_config_grants.sql`, "utf8");
    expect(sql6).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE stratifit_app IN SCHEMA public REVOKE ALL ON TABLES FROM stratifit_runtime;",
    );
  });

  it("no migration grants stratifit_runtime any privilege on platform_config", () => {
    const grants = migrationText().flatMap((t) =>
      uncommented(t).match(/GRANT[^;]*ON TABLE public\.platform_config[^;]*TO stratifit_runtime/g) ?? [],
    );
    expect(grants).toEqual([]);
  });

  it("net runtime privileges across all migrations equal the explicit allowlist", () => {
    const privs = new Map<string, Set<string>>();
    const addOrRemove = (stmt: string, remove: boolean) => {
      const norm = stmt.replace(/"/g, "");
      const m = norm.match(
        /^(GRANT|REVOKE) ([A-Z, ]+?) ON TABLE public\.(\w+) (?:TO|FROM) stratifit_runtime/,
      );
      if (!m?.[2] || !m[3]) return;
      const set = privs.get(m[3]) ?? new Set<string>();
      for (const p of m[2].split(",").map((s) => s.trim())) {
        if (remove) set.delete(p);
        else set.add(p);
      }
      privs.set(m[3], set);
    };
    const all = migrationText()
      .map((t) => uncommented(t).replace(/"/g, ""))
      .join("\n");
    for (const g of all.match(/GRANT [^;]*ON TABLE public\.\w+ TO stratifit_runtime/g) ?? []) {
      addOrRemove(g, false);
    }
    for (const r of all.match(/REVOKE [^;]*ON TABLE public\.\w+ FROM stratifit_runtime/g) ?? []) {
      addOrRemove(r, true);
    }
    // Tables whose net privilege set is empty (e.g. platform_config:
    // revoked in 0006, never granted) carry no access and are excluded.
    const names = [...privs.entries()].filter(([, set]) => set.size > 0).map(([t]) => t).sort();
    expect(names).toEqual(Object.keys(RUNTIME_PRIVILEGE_MAP).sort());
    for (const [table, expected] of Object.entries(RUNTIME_PRIVILEGE_MAP)) {
      expect([...(privs.get(table) ?? [])].sort()).toEqual([...expected].sort());
    }
    // platform_config: revoked in 0006, never granted — net privilege set is empty.
    expect([...(privs.get("platform_config") ?? [])]).toEqual([]);
  });

  it("audit_log is append-only: net runtime privileges are INSERT+SELECT, never UPDATE/DELETE", () => {
    const auditGrants = migrationText().flatMap((t) =>
      uncommented(t).match(/GRANT [^;]*ON TABLE public\.audit_log[^;]*TO stratifit_runtime/g) ?? [],
    );
    expect(auditGrants.join("\n")).toContain(
      "GRANT INSERT, SELECT ON TABLE public.audit_log TO stratifit_runtime",
    );
    for (const g of auditGrants) expect(g).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it("audit_log has no UPDATE or DELETE RLS policy in any migration", () => {
    const policies = migrationText().flatMap((t) =>
      uncommented(t).match(/CREATE POLICY [^;]*ON public\.audit_log[^;]*;/g) ?? [],
    );
    expect(policies.length).toBeGreaterThanOrEqual(2);
    for (const p of policies) {
      expect(p).toContain("TO stratifit_runtime");
      expect(p).not.toMatch(/FOR UPDATE|FOR DELETE/);
    }
  });

  it("no default-privilege statement re-grants stratifit_runtime table access", () => {
    const offending = migrationText().flatMap((t) =>
      uncommented(t).match(/ALTER DEFAULT PRIVILEGES[^;]*GRANT[^;]*TO stratifit_runtime/gi) ?? [],
    );
    expect(offending).toEqual([]);
  });
});

describe("domain-table guard (per approved plan)", () => {
  it("contains no domain tables yet", () => {
    const exported = Object.keys(schemaExports);
    const forbidden = [
      "productions",
      "scenes",
      "shots",
      "assets",
      "generations",
      "publications",
      "aiCreators",
      "conversations",
      "messages",
      "auditLogs",
    ];
    for (const name of forbidden) expect(exported).not.toContain(name);
  });
});
