import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Live security guard for the approved Stage 2.2 least-privilege reduction
 * (read-only catalog queries only; gated like the other integration tests on
 * the git-ignored root .env, connecting as the migration role). Verifies
 * against the LIVE remote:
 *   - stratifit_runtime has NO privileges on platform_config;
 *   - the six tenancy tables retain exactly arwd (the explicit allowlist);
 *   - the blanket stratifit_app default table privilege is gone (Option A);
 *   - role attributes (LOGIN-only, non-superuser, no CREATEDB/CREATEROLE/
 *     REPLICATION/BYPASSRLS) and zero ownership;
 *   - RLS remains enabled with only runtime-scoped policies.
 */
const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const migrateUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;

const d = hasEnv && migrateUrl ? describe : describe.skip;

d("runtime privilege posture (live, gated, read-only)", () => {
  const sql = migrateUrl ? postgres(migrateUrl, { prepare: false, max: 1 }) : undefined;

  const runtimeTables = [
    "audience_users",
    "operators",
    "org_memberships",
    "organizations",
    "teams",
    "verification_requirements",
  ] as const;

  it("grants stratifit_runtime exactly arwd on the allowlisted tables and nothing on platform_config", async () => {
    const grants = await sql!`
      select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
      from information_schema.role_table_grants
      where grantee = 'stratifit_runtime' and table_schema = 'public'
      group by table_name`;
    const byTable = new Map(grants.map((g) => [g.table_name as string, g.privs as string]));
    for (const t of runtimeTables) expect(byTable.get(t)).toBe("DELETE,INSERT,SELECT,UPDATE");
    expect(byTable.get("platform_config")).toBeUndefined();
    expect([...byTable.keys()].sort()).toEqual([...runtimeTables].sort());
  });

  it("no stratifit_app default table privilege grants stratifit_runtime anything (Option A)", async () => {
    const acl = await sql!`
      select defaclacl from pg_default_acl
      where defaclrole = 'stratifit_app'::regrole and defaclobjtype = 'r'`;
    expect(acl).toHaveLength(0);
  });

  it("stratifit_runtime stays LOGIN-only with zero ownership and no privileged attributes", async () => {
    const [role] = await sql!`
      select rolsuper as superuser, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
      from pg_roles where rolname = 'stratifit_runtime'`;
    expect(role).toBeDefined();
    expect(role!.rolcanlogin).toBe(true);
    expect(role!.superuser).toBe(false);
    expect(role!.rolcreatedb).toBe(false);
    expect(role!.rolcreaterole).toBe(false);
    expect(role!.rolreplication).toBe(false);
    expect(role!.rolbypassrls).toBe(false);
    const owned = await sql!`
      select count(*)::int as n from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relowner = 'stratifit_runtime'::regrole`;
    expect(owned[0]!.n).toBe(0);
  });

  it("RLS stays enabled on the six tenancy tables with only runtime-scoped policies", async () => {
    const rls = await sql!`
      select c.relname, c.relrowsecurity as enabled
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${sql!(runtimeTables)}`;
    for (const r of rls) expect(r.enabled).toBe(true);
    expect(rls).toHaveLength(runtimeTables.length);
    const policies = await sql!`
      select count(*)::int as n from pg_policies
      where schemaname = 'public' and (roles is null or roles::text not like '%stratifit_runtime%')
      and tablename in ${sql!(runtimeTables)}`;
    // Every policy on Stratifit tenancy tables must be runtime-scoped.
    expect(policies[0]!.n).toBe(0);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
  });
});
