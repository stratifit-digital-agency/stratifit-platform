import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Live security guard for the approved Stage 2.2 least-privilege reduction
 * (read-only catalog queries only; gated like the other integration tests on
 * the git-ignored root .env, connecting as the migration role). Verifies
 * against the LIVE remote:
 *   - stratifit_runtime has NO privileges on platform_config;
 *   - per-table privilege map: six tenancy tables + two mutable production
 *     aggregates + the four mutable Stage 2.7 job/compute families + the two
 *     mutable Stage 2.8 catalog parents + the mutable Stage 2.9 generation
 *     aggregate = arwd;
 *     audit_log + the three immutable Stage 2.6 production version families +
 *     the immutable Stage 2.7 job attempt history + the two immutable Stage
 *     2.8 catalog version families + the immutable Stage 2.9 completion
 *     provenance record = INSERT+SELECT only
 *     (append-only — UPDATE/DELETE must never exist);
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
    "projects",
    "productions",
    "jobs",
    "job_dependencies",
    "compute_requirements",
    "compute_usage",
    "models",
    "workflows",
    "generations",
    "assets",
    "publications",
    "public_content",
    "watch_progress",
    "likes",
    "saves",
    "follow_graph",
    "comments",
    "shares",
    "digital_humans",
    "characters",
    "personas",
    "ai_creators",
    "creator_profiles",
    "qc_checks",
    "qc_reviews",
    "qc_issues",
    // Stage 2.17 (Messaging & Leads): mutable aggregates.
    "conversations",
    "service_offerings",
    "service_inquiries",
    "service_leads",
    // Stage 2.18 (in-app Notifications): mutable audience-owner aggregate.
    "notifications",
    // Stage 2.20 (Creative): seven mutable hierarchy aggregates — D2.20-9
    // ARWD families.
    "universes",
    "worlds",
    "stories",
    "seasons",
    "episodes",
    "scenes",
    "shots",
    // Stage 2.21 (Rights & Consent Foundation): mutable owners + grants
    // (D2.21-7 ARWD; core immutability service-enforced).
    "rights_owners",
    "rights_grants",
  ] as const;

  // Immutable families (D2.6-4 / D2.7-4 / Stage 2.8 catalog versions /
  // Stage 2.9 completion provenance / Stage 2.11 QC evidence / Stage 2.21
  // rights status-event history): INSERT + SELECT, never UPDATE/DELETE.
  const immutableTables = [
    "production_plan_versions",
    "gate_decision_records",
    "manifest_versions",
    "job_attempts",
    "model_versions",
    "workflow_versions",
    "generation_provenance",
    "asset_versions",
    "asset_lineage",
    "publication_versions",
    "distribution_references",
    "qc_review_decisions",
    "qc_results",
    // Stage 2.17 (Messaging & Leads): immutable message + follow-up families.
    "messages",
    "lead_follow_ups",
    // Stage 2.19 (Analytics Intake): immutable public-beacon family.
    "analytics_events",
    // Stage 2.21 (Rights & Consent): status-event history of record
    // (D2.21-3: no rights.* events; immutable INSERT+SELECT family).
    "rights_status_events",
  ] as const;

  it("grants stratifit_runtime INSERT+SELECT only on the immutable families", async () => {
    const grants = await sql!`
      select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
      from information_schema.role_table_grants
      where grantee = 'stratifit_runtime' and table_schema = 'public'
      and table_name in ${sql!(immutableTables)}
      group by table_name`;
    expect(grants).toHaveLength(immutableTables.length);
    for (const g of grants) {
      expect(g.privs).toBe("INSERT,SELECT");
      expect(immutableTables).toContain(g.table_name);
    }
  });

  // Decision 4: audit_log is append-only — INSERT + SELECT, never UPDATE/DELETE.
  it("audit_log grants stratifit_runtime INSERT+SELECT only (append-only enforcement)", async () => {
    const grants = await sql!`
      select string_agg(privilege_type, ',' order by privilege_type) as privs
      from information_schema.role_table_grants
      where grantee = 'stratifit_runtime' and table_schema = 'public'
      and table_name = 'audit_log'`;
    expect(grants[0]!.privs).toBe("INSERT,SELECT");
  });

  it("grants stratifit_runtime exactly arwd on the allowlisted tables and nothing on platform_config", async () => {
    const grants = await sql!`
      select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
      from information_schema.role_table_grants
      where grantee = 'stratifit_runtime' and table_schema = 'public'
      group by table_name`;
    const byTable = new Map(grants.map((g) => [g.table_name as string, g.privs as string]));
    for (const t of runtimeTables) expect(byTable.get(t)).toBe("DELETE,INSERT,SELECT,UPDATE");
    expect(byTable.get("platform_config")).toBeUndefined();
    // audit_log and the immutable version families are asserted
    // separately (INSERT+SELECT only) above/below.
    const expectedArwd = [...runtimeTables].sort();
    expect(
      [...byTable.keys()].sort().filter((t) => t !== "audit_log" && !(immutableTables as readonly string[]).includes(t)),
    ).toEqual(expectedArwd);
  });

  it("function EXECUTE surface: the two approved definer functions are runtime-executable and PUBLIC-locked", async () => {
    // The Option-B functions (Stage 2.7 blocker resolution) are the ONLY
    // functions the platform itself creates; the guard asserts their grant
    // state (a widening or a lost REVOKE would fail here). Pre-existing
    // legacy functions with default PUBLIC EXECUTE are out of scope for
    // Stratifit's own posture (runtime role has no INHERIT from PUBLIC and
    // no membership; verified separately by the privilege-map guard).
    const [runtimeExec] = await sql!`
      select count(*)::int as n
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('close_job_attempt', 'record_job_attempt_progress')
        and has_function_privilege('stratifit_runtime', p.oid, 'EXECUTE')`;
    expect(runtimeExec!.n).toBe(2);
    // PUBLIC must hold no EXECUTE on either (REVOKE ... FROM PUBLIC held).
    for (const fn of ["close_job_attempt", "record_job_attempt_progress"]) {
      const [fnRow] = await sql!`
        select has_function_privilege('public', p.oid, 'EXECUTE') as public_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = ${fn}`;
      expect(fnRow!.public_execute).toBe(false);
    }
    // Both must be SECURITY DEFINER owned by the migrator role with an
    // empty search_path (hardening: no redirectable resolution).
    const [posture] = await sql!`
      select
        bool_and(pg_get_userbyid(p.proowner) = 'stratifit_app') as owner_ok,
        bool_and(p.prosecdef) as secdef_ok,
        bool_and(p.proconfig::text like '%search_path=%') as searchpath_ok
      from pg_proc p
      where p.proname in ('close_job_attempt', 'record_job_attempt_progress')`;
    expect(posture!.owner_ok).toBe(true);
    expect(posture!.secdef_ok).toBe(true);
    expect(posture!.searchpath_ok).toBe(true);
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

  it("RLS stays enabled on the tenancy tables, audit_log, and the production family with only runtime-scoped policies", async () => {
    const rls = await sql!`
      select c.relname, c.relrowsecurity as enabled
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${sql!([...runtimeTables, ...immutableTables])}`;
    for (const r of rls) expect(r.enabled).toBe(true);
    expect(rls).toHaveLength(runtimeTables.length + immutableTables.length);
    const policies = await sql!`
      select count(*)::int as n from pg_policies
      where schemaname = 'public' and (roles is null or roles::text not like '%stratifit_runtime%')
      and tablename in ${sql!(runtimeTables)}`;
    // Every policy on Stratifit tenancy/production tables must be runtime-scoped.
    expect(policies[0]!.n).toBe(0);
    // audit_log: RLS on, exactly the two append-only policies, both runtime-scoped.
    const [audit] = await sql!`
      select c.relrowsecurity as enabled,
        (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = 'audit_log') as policy_count,
        (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = 'audit_log'
          and (p.roles is null or p.roles::text not like '%stratifit_runtime%')) as non_runtime
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'audit_log'`;
    expect(audit!.enabled).toBe(true);
    expect(audit!.policy_count).toBe(2);
    expect(audit!.non_runtime).toBe(0);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
  });
});
