import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schemaExports from "./schema";
import {
  assetLineage,
  assetVersions,
  assets,
  auditLog,
  aiCreators,
  audienceUsers,
  characters,
  comments,
  creatorProfiles,
  digitalHumans,
  followGraph,
  likes,
  personas,
  saves,
  shares,
  computeRequirements,
  computeUsage,
  gateDecisionRecords,
  generationProvenance,
  generations,
  jobAttempts,
  jobDependencies,
  jobs,
  manifestVersions,
  modelVersions,
  models,
  operators,
  organizations,
  orgMemberships,
  platformConfig,
  productionPlanVersions,
  productions,
  projects,
  qcChecks,
  qcIssues,
  qcResults,
  qcReviewDecisions,
  qcReviews,
  distributionReferences,
  publicationVersions,
  publications,
  publicContent,
  watchProgress,
  teams,
  verificationRequirements,
  workflowVersions,
  workflows,
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
      (k) =>
        !k.endsWith("Row") &&
        !k.startsWith("New") &&
        k !== "JOB_TYPES" &&
        k !== "MODEL_CAPABILITY_KINDS" &&
        k !== "GENERATION_STATUSES" &&
        k !== "ASSET_KINDS" &&
        k !== "ASSET_SUBTYPES" &&
        k !== "ASSET_APPROVAL_STATES" &&
        k !== "ASSET_VISIBILITIES" &&
        k !== "ASSET_DERIVATION_KINDS" &&
        k !== "QC_SUBJECT_KINDS" &&
        k !== "QC_CHECK_TYPES" &&
        k !== "QC_CHECK_STATUSES" &&
        k !== "QC_REVIEW_STATUSES" &&
        k !== "QC_DECISIONS" &&
        k !== "QC_OUTCOMES" &&
        k !== "QC_EVALUATED_BY" &&
        k !== "QC_SEVERITIES" &&
        k !== "QC_ISSUE_RESOLUTIONS" &&
        k !== "CONVERSATION_STATUSES" &&
        k !== "LEAD_STATUSES",
    );
    expect(exported.sort()).toEqual(
      [
        "auditLog",
        "assetLineage",
        "assetVersions",
        "assets",
        "audienceUsers",
        "computeRequirements",
        "computeUsage",
        "gateDecisionRecords",
        "generationProvenance",
        "generations",
        "jobAttempts",
        "jobDependencies",
        "jobs",
        "manifestVersions",
        "modelVersions",
        "models",
        "operators",
        "organizations",
        "orgMemberships",
        "platformConfig",
        "productionPlanVersions",
        "productions",
        "projects",
        "qcChecks",
        "qcIssues",
        "qcResults",
        "qcReviewDecisions",
        "qcReviews",
        "publicContent",
        "distributionReferences",
        "publicationVersions",
        "publications",
        "teams",
        "verificationRequirements",
        "watchProgress",
        "likes",
        "saves",
        "followGraph",
        "comments",
        "shares",
        "digitalHumans",
        "characters",
        "personas",
        "aiCreators",
        "creatorProfiles",
        "workflowVersions",
        "workflows",
        // Stage 2.17 (Messaging & Leads): service_offerings/service_leads —
        // the services/leads names are occupied by a foreign marketing/CRM
        // schema on the shared Supabase project (authorized deviation).
        "conversations",
        "messages",
        "serviceOfferings",
        "serviceInquiries",
        "serviceLeads",
        "leadFollowUps",
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
      "projects",
      "productions",
      "production_plan_versions",
      "gate_decision_records",
      "manifest_versions",
      "jobs",
      "job_dependencies",
      "job_attempts",
      "compute_requirements",
      "compute_usage",
      "models",
      "model_versions",
      "workflows",
      "workflow_versions",
      "generations",
      "generation_provenance",
      "assets",
      "asset_versions",
      "asset_lineage",
      "qc_checks",
      "qc_reviews",
      "qc_review_decisions",
      "qc_results",
      "qc_issues",
      "publications",
      "publication_versions",
      "distribution_references",
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
  // Stage 2.6 (D2.6-4): mutable production aggregates get full arwd; the three
  // immutable version families get INSERT + SELECT only — UPDATE/DELETE must
  // never be granted, mirroring the audit_log append-only pattern.
  projects: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  productions: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  production_plan_versions: ["INSERT", "SELECT"],
  gate_decision_records: ["INSERT", "SELECT"],
  manifest_versions: ["INSERT", "SELECT"],
  // Stage 2.7 (D2.7-5/D2.7-4): the four mutable job/compute families get full
  // arwd; the attempt history is append-only — INSERT + SELECT only.
  jobs: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  job_dependencies: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  compute_requirements: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  compute_usage: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  job_attempts: ["INSERT", "SELECT"],
  // Stage 2.8 (Catalog Foundation): mutable registry parents get full arwd;
  // the version families are append-only — INSERT + SELECT only.
  models: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  workflows: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  model_versions: ["INSERT", "SELECT"],
  workflow_versions: ["INSERT", "SELECT"],
  // Stage 2.9 (Generation Foundation): the mutable lifecycle aggregate gets
  // full arwd; the completion-provenance record is append-only — INSERT +
  // SELECT only (D2.9-1; the audit_log/job_attempts pattern).
  generations: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  generation_provenance: ["INSERT", "SELECT"],
  // Stage 2.10 (Asset Domain Foundation, D2.10-1): the mutable asset
  // aggregate carries the approval state machine and gets full arwd; the
  // version family and the lineage DAG edges are append-only — INSERT +
  // SELECT only (the audit_log/job_attempts/immutable-family pattern).
  assets: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  asset_versions: ["INSERT", "SELECT"],
  asset_lineage: ["INSERT", "SELECT"],
  // Stage 2.11 (QC Foundation): mutable definition/review/issue aggregates
  // get full arwd; decision records and results are append-only evidence —
  // INSERT + SELECT only (the immutable-family pattern).
  qc_checks: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  qc_reviews: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  qc_review_decisions: ["INSERT", "SELECT"],
  qc_results: ["INSERT", "SELECT"],
  qc_issues: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  // Stage 2.12 (Publishing Foundation): the mutable publication aggregate
  // gets full arwd; the immutable version snapshots and distribution
  // references are append-only evidence — INSERT + SELECT only.
  publications: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  publication_versions: ["INSERT", "SELECT"],
  distribution_references: ["INSERT", "SELECT"],
  // Stage 2.13 (Public Content Foundation): a MUTABLE projection aggregate
  // whose only sanctioned mutation is the published→unpublished status flip
  // (plus timestamps) — full arwd, org-scoped RLS runtime_all.
  public_content: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  // Stage 2.14 (Audience Platform State): mutable audience-owner state,
  // upsert-per-(user, content) through the owner-scoped audience command API
  // only — full arwd, role-scoped runtime_all.
  watch_progress: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  // Stage 2.15 (Social Graph Foundation): five runtime-ARWD aggregates —
  // likes/saves (hard-toggle), follow_graph (tombstone), comments
  // (visibility states), shares (immutable facts). Owner/org conditioning is
  // service-layer; D2.15-3: no social.* events.
  likes: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  saves: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  follow_graph: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  comments: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  shares: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  // Stage 2.16 (People chain foundation): four Control-authored mutable
  // chain aggregates + the publication-authored creator_profiles snapshot
  // family (D2.16-3: no arbitrary profile edit path). All runtime arwd,
  // role-scoped runtime_all; D2.16-2: Rights seam unwired.
  digital_humans: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  characters: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  personas: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  ai_creators: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  creator_profiles: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  // Stage 2.17 (Messaging & Leads Foundation): the mutable conversation
  // aggregate (state machine + denormalized unread counters + per-participant
  // read receipts, D2.17-7/D2.17-8) plus the mutable offering/inquiry/lead
  // family; messages and lead_follow_ups are IMMUTABLE families (DM section
  // 32.8 — INSERT + SELECT only, live 42501 proofs). NAMING NOTE: the offering
  // and lead tables are service_offerings/service_leads — public.services and
  // public.leads are occupied by a pre-existing foreign marketing/CRM schema
  // on the shared Supabase project (see DOMAIN_MODEL section 38).
  conversations: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  messages: ["INSERT", "SELECT"],
  service_offerings: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  service_inquiries: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  service_leads: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  lead_follow_ups: ["INSERT", "SELECT"],
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

  it("stage 2.6 immutable families never receive UPDATE or DELETE grants", () => {
    for (const table of ["production_plan_versions", "gate_decision_records", "manifest_versions"]) {
      const grants = migrationText().flatMap((t) =>
        uncommented(t).match(new RegExp(`GRANT [^;]*ON TABLE public\\.${table}[^;]*TO stratifit_runtime`, "g")) ?? [],
      );
      expect(grants.length).toBeGreaterThan(0);
      for (const g of grants) expect(g).not.toMatch(/\b(UPDATE|DELETE)\b/);
    }
  });

  it("stage 2.6 production tables are RLS-enabled with runtime-scoped policies only", () => {
    const sqlText = migrationText().join("\n");
    const policies = sqlText.match(/CREATE POLICY[^;]+;/g) ?? [];
    const productionPolicies = policies.filter((p) =>
      ["public.projects", "public.productions", "public.production_plan_versions", "public.gate_decision_records", "public.manifest_versions"].some((t) => p.includes(`ON ${t}`)),
    );
    expect(productionPolicies.length).toBeGreaterThanOrEqual(5);
    for (const p of productionPolicies) expect(p).toContain("TO stratifit_runtime");
  });

  it("stage 2.7 job_attempts is append-only: net runtime privileges are INSERT+SELECT, never UPDATE/DELETE", () => {
    const grants = migrationText().flatMap((t) =>
      uncommented(t).match(/GRANT [^;]*ON TABLE public\.job_attempts[^;]*TO stratifit_runtime/g) ?? [],
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it("stage 2.7 job/compute tables are RLS-enabled with runtime-scoped policies only", () => {
    const sqlText = migrationText().join("\n");
    const policies = sqlText.match(/CREATE POLICY[^;]+;/g) ?? [];
    const jobPolicies = policies.filter((p) =>
      ["public.jobs", "public.job_dependencies", "public.job_attempts", "public.compute_requirements", "public.compute_usage"].some((t) => p.includes(`ON ${t}`)),
    );
    expect(jobPolicies.length).toBeGreaterThanOrEqual(5);
    for (const p of jobPolicies) expect(p).toContain("TO stratifit_runtime");
  });
});

describe("domain-table guard (per approved plan)", () => {
  it("contains only the approved Stage 2.6 production family beyond identity/tenancy", () => {
    const exported = Object.keys(schemaExports);
    const forbidden = [
      "scenes",
      "shots",
      // "publications" graduated to an approved bounded context in Stage
      // 2.12 (Publishing Foundation) — it is no longer forbidden.
      // "aiCreators" graduated in Stage 2.16 (People: AI Creator & Public
      // Profile Foundation, D2.16-1 chain-only five-table scope).
      // "conversations"/"messages" graduated in Stage 2.17 (Messaging &
      // Leads Foundation) — the Stage 2.17 tables use service_offerings and
      // service_leads because public.services/public.leads are occupied by a
      // pre-existing foreign marketing/CRM application on the shared
      // Supabase project (authorized naming deviation).

      "auditLogs",
      "jobLeases",
      "workerLeases",
      "outboxEvents",
      "eventOutbox",
    ];
    for (const name of forbidden) expect(exported).not.toContain(name);
  });

  it("productions status CHECK matches the DOMAIN_MODEL section 32 state machine", () => {
    const migrationsDir2 = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const sqlText = readdirSync(migrationsDir2)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(`${migrationsDir2}/${f}`, "utf8"))
      .join("\n");
    expect(sqlText).toContain("productions_status_check");
    for (const state of [
      "draft", "planning", "in_gate", "approved", "queued", "in_production",
      "post_production", "qc", "ready_for_publication", "published", "archived",
      "on_hold", "changes_requested", "cancelled",
    ]) {
      expect(sqlText).toContain(`'${state}'`);
    }
  });

  it("projects: org-scoped unique slug; productions: org+project indexes", () => {
    const c = getTableColumns(projects);
    expect(Object.keys(c).sort()).toEqual(
      ["createdAt", "createdBy", "description", "id", "name", "orgId", "slug", "status", "updatedAt"],
    );
    expect(c.orgId.notNull).toBe(true);
    const p = getTableColumns(productions);
    expect(Object.keys(p).sort()).toEqual(
      ["createdAt", "currentManifestVersionId", "currentPlanVersionId", "id", "kind", "orgId", "projectId", "status", "title", "updatedAt"],
    );
    expect(p.orgId.notNull).toBe(true);
    expect(p.projectId.notNull).toBe(true);
    expect(p.status.notNull).toBe(true);
  });

  it("jobs: five-value type catalog, DM section 32 state machine, idempotency triple", () => {
    const c = getTableColumns(jobs);
    expect(Object.keys(c).sort()).toEqual(
      [
        "attemptCount",
        "cancellationRequested",
        "computeRequirementId",
        "createdAt",
        "id",
        "idempotencyKey",
        "jobType",
        "lastError",
        "manifestRef",
        "maxAttempts",
        "orgId",
        "priority",
        "progress",
        "status",
        "subjectId",
        "subjectKind",
        "updatedAt",
      ],
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.idempotencyKey.notNull).toBe(true);
    expect(c.subjectKind.notNull).toBe(true);
    expect(c.subjectId.notNull).toBe(true);
    expect(c.manifestRef.notNull).toBe(false);
    expect(c.computeRequirementId.notNull).toBe(false);
    expect(c.status.notNull).toBe(true);
  });

  it("job_dependencies: composite PK, both FKs to jobs, no updatedAt", () => {
    const c = getTableColumns(jobDependencies);
    expect(Object.keys(c).sort()).toEqual(["createdAt", "dependsOnJobId", "jobId", "orgId"]);
    expect(c.jobId.notNull).toBe(true);
    expect(c.dependsOnJobId.notNull).toBe(true);
  });

  it("job_attempts: append-only shape (no updatedAt), worker_ref is a plain string", () => {
    const c = getTableColumns(jobAttempts);
    expect(Object.keys(c).sort()).toEqual(
      ["allocationRef", "attemptNumber", "completedAt", "errorDetail", "id", "jobId", "orgId", "outcome", "progressSnapshot", "startedAt", "usageRecordId", "workerRef"],
    );
    // Immutability at the schema level: no updated_at column exists.
    expect("updatedAt" in c).toBe(false);
    expect(c.workerRef.notNull).toBe(true);
    expect(c.attemptNumber.notNull).toBe(true);
    expect(c.completedAt.notNull).toBe(false);
    expect(c.outcome.notNull).toBe(false);
  });

  it("compute_requirements/usage: pure estimate and actual records", () => {
    const r = getTableColumns(computeRequirements);
    expect(Object.keys(r).sort()).toEqual(
      ["concurrency", "createdAt", "estimatedCostUsd", "estimatedRuntimeSeconds", "gpuClass", "id", "orgId", "storageMb", "vramGb", "workers"],
    );
    const u = getTableColumns(computeUsage);
    expect(Object.keys(u).sort()).toEqual(["actualCostUsd", "actualRuntimeSeconds", "allocationRef", "id", "orgId", "recordedAt"]);
  });

  it("immutable version families carry unique (production, version) and no updatedAt", () => {
    for (const t of [productionPlanVersions, gateDecisionRecords, manifestVersions]) {
      expect("updatedAt" in getTableColumns(t)).toBe(false);
    }
    const c = getTableColumns(productionPlanVersions);
    expect(c.versionNumber.notNull).toBe(true);
    const m = getTableColumns(manifestVersions);
    expect(m.versionNumber.notNull).toBe(true);
  });

  it("models: mutable parent with capability/status CHECKs and (org, name) uniqueness", () => {
    const c = getTableColumns(models);
    expect(Object.keys(c).sort()).toEqual(
      ["capabilityKind", "createdAt", "displayName", "id", "name", "orgId", "status", "updatedAt", "vendorLabel"],
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.capabilityKind.notNull).toBe(true);
    expect(c.status.notNull).toBe(true);
  });

  it("model_versions: immutable family shape (no updatedAt), unique (org, model, version)", () => {
    const c = getTableColumns(modelVersions);
    expect(Object.keys(c).sort()).toEqual(
      ["adapterRef", "compatibility", "defaultParameters", "id", "modelId", "orgId", "registeredAt", "status", "version"],
    );
    expect("updatedAt" in c).toBe(false);
    expect(c.modelId.notNull).toBe(true);
    expect(c.version.notNull).toBe(true);
    expect(c.adapterRef.notNull).toBe(true);
  });

  it("workflows: mutable parent with supports array and status CHECK", () => {
    const c = getTableColumns(workflows);
    expect(Object.keys(c).sort()).toEqual(["createdAt", "id", "name", "orgId", "status", "supports", "updatedAt"]);
    expect(c.orgId.notNull).toBe(true);
    expect(c.supports.notNull).toBe(true);
  });

  it("workflow_versions: immutable family shape (no updatedAt), unique (org, workflow, version)", () => {
    const c = getTableColumns(workflowVersions);
    expect(Object.keys(c).sort()).toEqual(
      ["compatibility", "definition", "id", "orgId", "registeredAt", "runtimeRef", "status", "version", "workflowId"],
    );
    expect("updatedAt" in c).toBe(false);
    expect(c.workflowId.notNull).toBe(true);
    expect(c.runtimeRef.notNull).toBe(true);
    expect(c.definition.notNull).toBe(true);
  });

  it("generations: DM section 32.3 lifecycle, loose cross-module refs, pinned catalog UUIDs", () => {
    const c = getTableColumns(generations);
    expect(Object.keys(c).sort()).toEqual(
      [
        "adapters",
        "createdAt",
        "durationSeconds",
        "estimatedCostUsd",
        "fps",
        "id",
        "inputAssetVersionIds",
        "jobId",
        "lastError",
        "modelId",
        "modelVersionId",
        "negativePrompt",
        "orgId",
        "outputAssetVersionId",
        "parameters",
        "parentGenerationId",
        "productionId",
        "prompt",
        "requestedAt",
        "requestKey",
        "resolution",
        "sceneId",
        "seed",
        "startedAt",
        "status",
        "updatedAt",
        "workflowId",
        "workflowVersionId",
        "shotId",
      ].sort(),
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.status.notNull).toBe(true);
    expect(c.prompt.notNull).toBe(true);
    expect(c.modelId.notNull).toBe(true);
    expect(c.modelVersionId.notNull).toBe(true);
    // Loose cross-module references (approved D2) — all nullable, no FKs.
    expect(c.productionId.notNull).toBe(false);
    expect(c.sceneId.notNull).toBe(false);
    expect(c.shotId.notNull).toBe(false);
    expect(c.jobId.notNull).toBe(false);
    expect(c.outputAssetVersionId.notNull).toBe(false);
    expect(c.workflowVersionId.notNull).toBe(false);
    // Request-provenance columns exist and are NOT updated_at-managed.
    expect(c.seed.notNull).toBe(false);
    expect(c.requestedAt.notNull).toBe(true);
    expect(c.requestKey.notNull).toBe(false);
  });

  it("generation_provenance: one-shot identity (PK = generation_id), immutable shape (no updatedAt)", () => {
    const c = getTableColumns(generationProvenance);
    expect(Object.keys(c).sort()).toEqual(
      [
        "actualCostUsd",
        "actualRuntimeSeconds",
        "completedAt",
        "executedSeed",
        "generationId",
        "gpuClass",
        "orgId",
        "outputByteSize",
        "outputChecksum",
        "outputStorageKey",
        "runtimeVersion",
        "workerRef",
      ].sort(),
    );
    expect("updatedAt" in c).toBe(false);
    // generation_id IS the primary key — the one-shot completion guard.
    expect(c.generationId.primary).toBe(true);
    expect(c.orgId.notNull).toBe(true);
    expect(c.completedAt.notNull).toBe(true);
  });

  it("assets: D2.10-1 mutable aggregate with approval state + current-version pointer, DM section 12 taxonomy", () => {
    const c = getTableColumns(assets);
    expect(Object.keys(c).sort()).toEqual(
      [
        "approvalState",
        "createdAt",
        "currentVersionId",
        "description",
        "id",
        "kind",
        "orgId",
        "productionId",
        "shotId",
        "subtype",
        "tags",
        "title",
        "updatedAt",
        "visibility",
      ].sort(),
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.kind.notNull).toBe(true);
    expect(c.title.notNull).toBe(true);
    // D2.10-1: the approval state machine lives on the MUTABLE aggregate.
    expect(c.approvalState.notNull).toBe(true);
    expect(c.visibility.notNull).toBe(true);
    // Pointer is null until the first version is registered (production precedent).
    expect(c.currentVersionId.notNull).toBe(false);
    // Loose cross-module references (approved D2) — all nullable, no FKs.
    expect(c.productionId.notNull).toBe(false);
    expect(c.shotId.notNull).toBe(false);
    expect(c.subtype.notNull).toBe(false);
  });

  it("asset_versions: immutable family shape (no updatedAt), unique (org, asset, version)", () => {
    const c = getTableColumns(assetVersions);
    expect(Object.keys(c).sort()).toEqual(
      [
        "assetId",
        "bucket",
        "byteSize",
        "checksum",
        "createdAt",
        "createdBy",
        "id",
        "mimeType",
        "orgId",
        "provenanceGenerationId",
        "storageKey",
        "technicalMetadata",
        "versionNumber",
      ].sort(),
    );
    expect("updatedAt" in c).toBe(false);
    expect(c.assetId.notNull).toBe(true);
    expect(c.versionNumber.notNull).toBe(true);
    // StorageRef metadata (DATA_FLOW section 11) is required on every version.
    expect(c.bucket.notNull).toBe(true);
    expect(c.storageKey.notNull).toBe(true);
    expect(c.checksum.notNull).toBe(true);
    expect(c.byteSize.notNull).toBe(true);
    expect(c.mimeType.notNull).toBe(true);
    // Provenance is a metadata-only reference into the Stage 2.9 family.
    expect(c.provenanceGenerationId.notNull).toBe(false);
  });

  it("asset_lineage: immutable DAG edges (no updatedAt), derivation-kind CHECK, no self-edge", () => {
    const c = getTableColumns(assetLineage);
    expect(Object.keys(c).sort()).toEqual(
      ["childVersionId", "createdAt", "derivationKind", "id", "orgId", "parentVersionId"],
    );
    expect("updatedAt" in c).toBe(false);
    expect(c.parentVersionId.notNull).toBe(true);
    expect(c.childVersionId.notNull).toBe(true);
    expect(c.derivationKind.notNull).toBe(true);
  });

  it("qc_checks: mutable definition shape (D2.11-1, D2.11-7 active|archived only)", () => {
    const c = getTableColumns(qcChecks);
    expect(Object.keys(c).sort()).toEqual(
      ["appliesToKind", "checkType", "createdAt", "id", "name", "orgId", "parameters", "required", "status", "updatedAt"].sort(),
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.name.notNull).toBe(true);
    expect(c.required.notNull).toBe(true);
    expect(c.status.notNull).toBe(true);
    expect(c.status.hasDefault).toBe(true);
  });

  it("qc_reviews: per-subject lifecycle (DM section 32.5), loose subject_ref, one lifecycle per subject", () => {
    const c = getTableColumns(qcReviews);
    expect(Object.keys(c).sort()).toEqual(
      ["createdAt", "id", "orgId", "requestedBy", "status", "subjectKind", "subjectRef", "updatedAt"].sort(),
    );
    expect(c.subjectRef.notNull).toBe(true);
    expect(c.status.notNull).toBe(true);
    // Loose cross-module reference (D2.11-2) — no FK, nullable requester.
    expect(c.requestedBy.notNull).toBe(false);
  });

  it("qc_review_decisions: immutable evidence (no updatedAt), reviewer never null (D2.11-3)", () => {
    const c = getTableColumns(qcReviewDecisions);
    expect(Object.keys(c).sort()).toEqual(
      ["capabilityUsed", "createdAt", "decision", "id", "orgId", "reason", "reviewId", "reviewerOperatorId"].sort(),
    );
    expect("updatedAt" in c).toBe(false);
    expect(c.reviewerOperatorId.notNull).toBe(true);
    expect(c.reviewId.notNull).toBe(true);
    expect(c.capabilityUsed.notNull).toBe(true);
  });

  it("qc_results: immutable append-only results (no updatedAt), provenance fields", () => {
    const c = getTableColumns(qcResults);
    expect(Object.keys(c).sort()).toEqual(
      ["checkId", "details", "evaluatedAt", "evaluatedBy", "id", "orgId", "outcome", "reviewId", "ruleRef"].sort(),
    );
    expect("updatedAt" in c).toBe(false);
    expect(c.outcome.notNull).toBe(true);
    expect(c.evaluatedBy.notNull).toBe(true);
    expect(c.ruleRef.notNull).toBe(false);
  });

  it("qc_issues: mutable resolution lifecycle named exactly `resolution` (approved)", () => {
    const c = getTableColumns(qcIssues);
    expect(Object.keys(c).sort()).toEqual(
      ["createdAt", "description", "id", "orgId", "resolution", "resolvedAt", "resolvedBy", "resultId", "severity", "updatedAt"].sort(),
    );
    expect(c.resolution.notNull).toBe(true);
    expect(c.resolvedBy.notNull).toBe(false);
    expect(c.resolvedAt.notNull).toBe(false);
  });

  it("publications: mutable DM section 32.6 aggregate, loose subject_ref, one lifecycle per subject+platform, approval-time qc_review_id", () => {
    const c = getTableColumns(publications);
    expect(Object.keys(c).sort()).toEqual(
      ["attemptCount", "contentType", "createdAt", "currentVersionId", "id", "lastAttemptAt", "lastFailureReason", "orgId", "platformTarget", "qcReviewId", "scheduledFor", "status", "subjectKind", "subjectRef", "updatedAt"].sort(),
    );
    expect(c.subjectRef.notNull).toBe(true);
    expect(c.status.notNull).toBe(true);
    expect(c.status.hasDefault).toBe(true);
    // The FROZEN approval-time QC reference lives on the publication and is
    // nullable until approve stamps it.
    expect(c.qcReviewId.notNull).toBe(false);
  });

  it("publication_versions: immutable snapshot family (no updatedAt), EXACT frozen shape (no qc_review_id, no subject_snapshot)", () => {
    const c = getTableColumns(publicationVersions);
    expect(Object.keys(c).sort()).toEqual(
      ["contentType", "createdAt", "createdBy", "id", "orgId", "publicationId", "subjectKind", "subjectRef", "synopsis", "title", "versionNumber"].sort(),
    );
    expect("updatedAt" in c).toBe(false);
    expect("qcReviewId" in c).toBe(false);
    expect("subjectSnapshot" in c).toBe(false);
    expect("platformTarget" in c).toBe(false);
    expect(c.title.notNull).toBe(true);
    expect(c.versionNumber.notNull).toBe(true);
    expect(c.subjectKind.notNull).toBe(true);
    expect(c.subjectRef.notNull).toBe(true);
  });

  it("distribution_references: immutable attempt record (no updatedAt), FROZEN delivery_outcome delivered|failed, no credentials", () => {
    const c = getTableColumns(distributionReferences);
    expect(Object.keys(c).sort()).toEqual(
      ["createdAt", "deliveryOutcome", "externalRef", "failureReason", "id", "orgId", "platformTarget", "publicationId", "versionId"].sort(),
    );
    expect("updatedAt" in c).toBe(false);
    expect("status" in c).toBe(false);
    expect(c.deliveryOutcome.notNull).toBe(true);
    expect(c.versionId.notNull).toBe(true);
    expect(c.externalRef.notNull).toBe(false);
    expect(c.failureReason.notNull).toBe(false);
  });

  it("asset migrations: lineage derivation kinds match DM section 12 exactly; RLS enabled", () => {
    const migrationsDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const sqlText = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(`${migrationsDir}/${f}`, "utf8"))
      .join("\n");
    expect(sqlText).toContain("asset_lineage_derivation_kind_check");
    for (const kind of ["generation", "edit", "transcode", "thumbnail", "trailer", "upscale", "enhancement"]) {
      expect(sqlText).toContain(`'${kind}'`);
    }
    expect(sqlText).toContain("asset_lineage_no_self_edge_check");
    for (const table of ["assets", "asset_versions", "asset_lineage"]) {
      expect(sqlText).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    }
    const policies = sqlText.match(/CREATE POLICY[^;]+;/g) ?? [];
    const assetPolicies = policies.filter((p) =>
      ["public.assets", "public.asset_versions", "public.asset_lineage"].some((t) => p.includes(`ON ${t}`)),
    );
    for (const p of assetPolicies) expect(p).toContain("TO stratifit_runtime");
  });

  it("public_content: Stage 2.13 projection aggregate — frozen shape, UNIQUE(slug)+UNIQUE(publication_version_id), FK RESTRICT to the publishing family, RLS enabled", () => {
    const c = getTableColumns(publicContent);
    expect(Object.keys(c).sort()).toEqual(
      [
        "categories", "contentType", "createdAt", "creatorProfileRef", "durationSeconds",
        "episodeNumber", "id", "mediaRefs", "orgId", "publicationId", "publicationVersionId",
        "publishedAt", "seriesRef", "slug", "status", "synopsis", "title", "updatedAt",
      ].sort(),
    );
    expect(c.slug.notNull).toBe(true);
    expect(c.publicationVersionId.notNull).toBe(true);
    expect(c.publicationId.notNull).toBe(true);
    expect(c.orgId.notNull).toBe(true);
    expect(c.title.notNull).toBe(true);
    expect(c.publishedAt.notNull).toBe(true);
    expect(c.status.notNull).toBe(true);
    expect(c.status.hasDefault).toBe(true);
    expect(c.synopsis.notNull).toBe(false);
    expect(c.creatorProfileRef).toBeDefined();
    expect(c.creatorProfileRef!.notNull).toBe(false);
    expect(c.seriesRef!.notNull).toBe(false);
    expect(c.episodeNumber!.notNull).toBe(false);
    expect(c.durationSeconds!.notNull).toBe(false);
    const migrationsDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const sqlText = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(`${migrationsDir}/${f}`, "utf8"))
      .join("\n");
    // D2.13-2 global slug uniqueness + D2.13-4 idempotency uniqueness.
    expect(sqlText).toContain('UNIQUE("slug")');
    expect(sqlText).toContain('UNIQUE("publication_version_id")');
    for (const fk of [
      "public_content_org_id_organizations_id_fk",
      "public_content_publication_id_publications_id_fk",
      "public_content_publication_version_id_publication_versions_id_fk",
    ]) {
      expect(sqlText).toContain(fk);
      const fkDef = sqlText.slice(sqlText.indexOf(fk), sqlText.indexOf(fk) + 220);
      expect(fkDef).toContain("ON DELETE restrict");
    }
    // RLS enabled in 0027; runtime_all policy TO stratifit_runtime in 0028.
    expect(sqlText).toContain('ALTER TABLE "public_content" ENABLE ROW LEVEL SECURITY;');
    const policies = sqlText.match(/CREATE POLICY[^;]+;/g) ?? [];
    const pcPolicies = policies.filter((p) => p.includes("ON public.public_content"));
    expect(pcPolicies).toHaveLength(1);
    expect(pcPolicies[0]).toContain("TO stratifit_runtime");
  });
});
describe("watch_progress (Stage 2.14 audience platform state)", () => {
  it("frozen shape: per (user, content) upsert key, FK RESTRICT, RLS, ARWD, no PUBLIC", () => {
    const cols = getTableColumns(watchProgress);
    expect(Object.keys(cols).sort()).toEqual(
      ["audienceUserId", "contentRef", "createdAt", "id", "orgId", "positionSeconds", "updatedAt"],
    );
    expect(cols.orgId.notNull).toBe(true);
    expect(cols.audienceUserId.notNull).toBe(true);
    expect(cols.contentRef.notNull).toBe(true);
    expect(cols.positionSeconds.notNull).toBe(true);
    const ddlDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const ddl = readdirSync(ddlDir)
      .filter((f) => f.startsWith("0029_") || f.startsWith("0030_"))
      .map((f) => readFileSync(ddlDir + "/" + f, "utf8"))
      .join("\n");
    for (const fragment of [
      "REFERENCES \"public\".\"organizations\"(\"id\") ON DELETE restrict",
      "ENABLE ROW LEVEL SECURITY",
      "CREATE POLICY runtime_all ON public.watch_progress FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true)",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.watch_progress TO stratifit_runtime",
    ]) {
      expect(ddl).toContain(fragment);
    }
    expect(ddl).not.toMatch(/TO PUBLIC/);
  });
});

describe("social graph (Stage 2.15, D2.15-1..6)", () => {
  it("likes/saves frozen shape: idempotent (user, content) key, FK RESTRICT, RLS, no tombstone", () => {
    for (const [tbl, table] of [
      ["likes", likes],
      ["saves", saves],
    ] as const) {
      const cols = getTableColumns(table);
      expect(Object.keys(cols).sort()).toEqual(["audienceUserId", "contentRef", "createdAt", "id", "orgId"]);
      expect(cols.orgId.notNull).toBe(true);
      expect(cols.audienceUserId.notNull).toBe(true);
      expect(cols.contentRef.notNull).toBe(true);
      // D2.15-2: hard-delete toggles — NO tombstone column may exist.
      expect("deletedAt" in cols).toBe(false);
      const ddl = readdirSync(fileURLToPath(new URL("../drizzle/", import.meta.url)))
        .filter((f) => f.startsWith("0031_") || f.startsWith("0032_"))
        .map((f) => readFileSync(fileURLToPath(new URL(`../drizzle/${f}`, import.meta.url)), "utf8"))
        .join("\n");
      expect(ddl).toContain(`UNIQUE("audience_user_id","content_ref")`);
      expect(ddl).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${tbl} TO stratifit_runtime`);
    }
  });

  it("follow_graph frozen shape: tombstone, kind/target XOR checks, no-self-follow, partial active unique", () => {
    const cols = getTableColumns(followGraph);
    expect(Object.keys(cols).sort()).toEqual(
      ["createdAt", "deletedAt", "followeeAudienceUserId", "followeeCreatorProfileRef", "followeeKind", "followerId", "id", "orgId", "updatedAt"],
    );
    // D2.15-1: creator_profile target has NO foreign key (People not durable).
    expect(cols.followeeCreatorProfileRef.isUnique).toBe(false);
    const ddl =
      readdirSync(fileURLToPath(new URL("../drizzle/", import.meta.url)))
        .filter((f) => f.startsWith("0031_"))
        .map((f) => readFileSync(fileURLToPath(new URL(`../drizzle/${f}`, import.meta.url)), "utf8"))
        .join("\n");
    expect(ddl).toContain("follow_graph_no_self_follow_check");
    expect(ddl).toContain("follow_graph_followee_kind_check");
    expect(ddl).toContain("follow_graph_followee_target_check");
    // D2.15-2: partial UNIQUE so a tombstoned row can be reactivated.
    expect(ddl).toContain("WHERE \"follow_graph\".\"followee_kind\" = 'audience_user' and \"follow_graph\".\"deleted_at\" is null");
  });

  it("comments frozen shape: visibility enum, body length, parent self-FK RESTRICT", () => {
    const cols = getTableColumns(comments);
    expect(Object.keys(cols).sort()).toEqual(
      ["authorId", "body", "contentRef", "createdAt", "id", "orgId", "parentCommentId", "updatedAt", "visibility"],
    );
    expect(cols.visibility.notNull).toBe(true);
    const ddl =
      readdirSync(fileURLToPath(new URL("../drizzle/", import.meta.url)))
        .filter((f) => f.startsWith("0031_"))
        .map((f) => readFileSync(fileURLToPath(new URL(`../drizzle/${f}`, import.meta.url)), "utf8"))
        .join("\n");
    expect(ddl).toContain("comments_visibility_check");
    expect(ddl).toContain("comments_body_length_check");
    expect(ddl).toContain("comments_parent_comment_id_comments_id_fk");
  });

  it("shares frozen shape: narrow channel enum, immutable-fact shape (no unique on user+content)", () => {
    const cols = getTableColumns(shares);
    expect(Object.keys(cols).sort()).toEqual(["audienceUserId", "channel", "contentRef", "createdAt", "id", "orgId"]);
    const ddl =
      readdirSync(fileURLToPath(new URL("../drizzle/", import.meta.url)))
        .filter((f) => f.startsWith("0031_"))
        .map((f) => readFileSync(fileURLToPath(new URL(`../drizzle/${f}`, import.meta.url)), "utf8"))
        .join("\n");
    expect(ddl).toContain("shares_channel_check");
    // D2.15-6: no arbitrary channel strings beyond the two frozen values.
    expect(ddl).toContain("('copy_link', 'external')");
    // Immutable facts: duplicates are distinct — no uniqueness constraint.
    expect(ddl).not.toContain("shares_user_content_unique");
  });

  it("0032 grants ARWD to all five social tables and no PUBLIC privileges", () => {
    const ddl = readFileSync(fileURLToPath(new URL("../drizzle/0032_social_grants_policies.sql", import.meta.url)), "utf8");
    for (const tbl of ["likes", "saves", "follow_graph", "comments", "shares"]) {
      expect(ddl).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${tbl} TO stratifit_runtime`);
      expect(ddl).toContain(`CREATE POLICY runtime_all ON public.${tbl} FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true)`);
    }
    expect(ddl).not.toMatch(/TO PUBLIC/);
  });
});
