import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * FOUNDATION SCHEMA — Stage 2.3 (identity foundation).
 *
 * Ownership (SERVICE_ARCHITECTURE section 11): packages/database is the sole
 * Drizzle schema owner; the identity table families below are owned
 * conceptually by services/identity. Tenancy per approved Decision 1 (D1):
 * org_id on domain tables (NOT NULL); platform-level tables carry no org_id.
 * The single default organization is seeded by migration 0002 (slug
 * 'stratifit'); audience users are bound to it at provisioning time by
 * services/identity (no DB default — the binding is a runtime decision).
 *
 * Security: every table enables RLS with ZERO policies (deny-by-default).
 * The application reaches these tables only through services/identity using
 * the dedicated least-privilege connection role (table owner), so RLS never
 * blocks the server-side path while the exposed Supabase Data API roles
 * (anon/authenticated) see nothing.
 *
 * Cross-module rule (D2): the only FKs here are intra-family (identity -> identity).
 * No domain tables are defined yet (Stage 2.6 is separately gated).
 *
 * Stage 2.2 additions (approved decisions D-1..D-5):
 *  - `teams`: assignment-only operator groupings (DOMAIN_MODEL section 6) — NOT a
 *    second tenancy level and NOT an authorization scope.
 *  - `org_memberships`: the SOLE authoritative source of operator authorization
 *    (D-1: `operators.roles` is deprecated compatibility metadata only, never a
 *    fallback). Org-scoped rows carry the authorization role; team-scoped rows
 *    structurally CANNOT (role is NULL iff team-scoped, enforced by CHECK — D-3).
 *  - Fail-closed (D-2): no active membership => the operator does not resolve.
 *  - Append-and-revoke history (DOMAIN_MODEL section 6): revoked rows are
 *    end-of-life; re-granting inserts a new row (partial unique indexes admit
 *    at most one non-revoked membership per (operator, org) and (operator, team)).
 */

/** Tenancy root. Globally unique slug (explicit architectural assumption). */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      // 'archived' added in Stage 2.2 (org lifecycle: read-only-in-practice terminal state).
      "organizations_status_check",
      sql`${t.status} in ('active', 'suspended', 'archived')`,
    ),
  ],
).enableRLS();

/** Internal Control operators. Distinct entity from audience users (invariant 12). */
export const operators = pgTable(
  "operators",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Opaque external identity-provider subject (Supabase Auth). Never an FK. */
    authSubjectRef: text("auth_subject_ref").notNull().unique(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    roles: text("roles")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "operators_roles_subset_check",
      sql`${t.roles} <@ array['admin', 'operator', 'reviewer', 'viewer']::text[]`,
    ),
    index("idx_operators_org").on(t.orgId),
  ],
).enableRLS();

/**
 * Public Media users. Audience, not producers (invariant 16). Rows are JIT-
 * provisioned by services/identity on first authenticated resolution; the
 * default-org binding is applied at insert time (no DB default). Operators
 * are never auto-provisioned here.
 */
export const audienceUsers = pgTable(
  "audience_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    authSubjectRef: text("auth_subject_ref").notNull().unique(),
    email: text("email"),
    /** Server-derived mirror of provider state; refreshed at resolution time. */
    emailVerified: boolean("email_verified").notNull().default(false),
    handle: text("handle").unique(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_audience_users_org").on(t.orgId)],
).enableRLS();

/**
 * Verification requirements as DATA, not code forks (DOMAIN_MODEL section 6).
 * Platform-level: no org_id (D1). Keys mirror @stratifit/contracts SocialAction.
 */
export const verificationRequirements = pgTable("verification_requirements", {
  action: text("action").primaryKey(),
  requiredVerifications: text("required_verifications")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Assignment-only grouping of operators inside one organization (DM section 6:
 * "without adding a second tenancy level"). Slug is unique PER ORG (teams are
 * org-internal; unlike the globally unique organization slug).
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("teams_status_check", sql`${t.status} in ('active', 'archived')`),
    unique("teams_org_slug_unique").on(t.orgId, t.slug),
    index("idx_teams_org").on(t.orgId),
  ],
).enableRLS();

/**
 * Operator membership grants — the authoritative authorization record (D-1).
 *
 * Exactly one of organization_id / team_id per row (generic DM Membership tuple).
 * - Org-scoped row: role NOT NULL in the approved role set => contributes capabilities.
 * - Team-scoped row: role MUST be NULL (D-3: assignment-only; a team can never
 *   grant capabilities). CHECKs make an accidental capability grant on a team
 *   row unrepresentable.
 * - History: `revoked` rows persist (revokedAt set); re-granting inserts a new
 *   row. Partial unique indexes enforce at most one non-revoked grant per scope.
 */
export const orgMemberships = pgTable(
  "org_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    /** Null iff team-scoped (D-3). Org-scoped rows require a role (CHECK). */
    role: text("role"),
    status: text("status").notNull().default("active"),
    /** Granting operator; nullable only for the controlled first-operator runbook. */
    grantedBy: uuid("granted_by").references(() => operators.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "org_memberships_role_check",
      sql`${t.role} is null or ${t.role} in ('admin', 'operator', 'reviewer', 'viewer')`,
    ),
    check(
      "org_memberships_status_check",
      sql`${t.status} in ('active', 'inactive', 'suspended', 'revoked')`,
    ),
    check(
      "org_memberships_scope_exactly_one_check",
      sql`num_nonnulls(${t.organizationId}, ${t.teamId}) = 1`,
    ),
    // D-3 structural guarantee: org row => role required; team row => role forbidden.
    check("org_memberships_org_role_required_check", sql`${t.teamId} is not null or ${t.role} is not null`),
    check("org_memberships_team_role_forbidden_check", sql`${t.teamId} is null or ${t.role} is null`),
    check(
      "org_memberships_revoked_at_check",
      sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
    index("idx_org_memberships_operator").on(t.operatorId),
    index("idx_org_memberships_org").on(t.organizationId),
    index("idx_org_memberships_team").on(t.teamId),
    uniqueIndex("org_memberships_org_nonrevoked_unique")
      .on(t.operatorId, t.organizationId)
      .where(sql`${t.organizationId} is not null and ${t.status} <> 'revoked'`),
    uniqueIndex("org_memberships_team_nonrevoked_unique")
      .on(t.operatorId, t.teamId)
      .where(sql`${t.teamId} is not null and ${t.status} <> 'revoked'`),
  ],
).enableRLS();

/**
 * Domain-neutral platform configuration store (foundational, unchanged).
 */
export const platformConfig = pgTable("platform_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;
export type OperatorRow = typeof operators.$inferSelect;
export type NewOperatorRow = typeof operators.$inferInsert;
export type AudienceUserRow = typeof audienceUsers.$inferSelect;
export type NewAudienceUserRow = typeof audienceUsers.$inferInsert;
export type VerificationRequirementRow = typeof verificationRequirements.$inferSelect;
export type NewVerificationRequirementRow = typeof verificationRequirements.$inferInsert;
export type TeamRow = typeof teams.$inferSelect;
export type NewTeamRow = typeof teams.$inferInsert;
export type OrgMembershipRow = typeof orgMemberships.$inferSelect;
export type NewOrgMembershipRow = typeof orgMemberships.$inferInsert;
export type PlatformConfigRow = typeof platformConfig.$inferSelect;
export type NewPlatformConfigRow = typeof platformConfig.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type ProductionRow = typeof productions.$inferSelect;
export type NewProductionRow = typeof productions.$inferInsert;
export type ProductionPlanVersionRow = typeof productionPlanVersions.$inferSelect;
export type NewProductionPlanVersionRow = typeof productionPlanVersions.$inferInsert;
export type GateDecisionRecordRow = typeof gateDecisionRecords.$inferSelect;
export type NewGateDecisionRecordRow = typeof gateDecisionRecords.$inferInsert;
export type ManifestVersionRow = typeof manifestVersions.$inferSelect;
export type NewManifestVersionRow = typeof manifestVersions.$inferInsert;

/**
 * Append-only audit trail (SERVICE_ARCHITECTURE section 11; Decision 4).
 *
 * Conceptual owner: services/admin-audit — the ONLY sanctioned writer via
 * `admin-audit.append`. Rows are immutable by construction: no updated_at
 * column, and the runtime role receives INSERT + SELECT privileges only
 * (migration 0009) with no UPDATE/DELETE RLS policies. `actor_id`/`subject_id`
 * deliberately carry no cross-module FK (D2). `payload` holds opaque,
 * secret-free before/after snapshots and correlation fields per DM section 38.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** Null only for platform-level actions (D1 infrastructure carve-out). */
    organizationId: uuid("organization_id"),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("audit_log_action_check", sql`${t.action} <> ''`),
    check("audit_log_subject_kind_check", sql`${t.subjectKind} <> ''`),
    index("idx_audit_log_org_time").on(t.organizationId, t.occurredAt.desc()),
    index("idx_audit_log_subject").on(t.subjectKind, t.subjectId),
    index("idx_audit_log_actor_time").on(t.actorId, t.occurredAt.desc()),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Production domain (Stage 2.6, approved decisions D2.6-1..D2.6-4)
//
// Conceptual owner: services/production-engine (SVC section 11 context 2).
// Tenancy per D1: org_id NOT NULL on every table. Cross-module rule (D2):
// the only FKs are intra-family (production -> production); downstream
// families (assets, generations, jobs, QC, publications) reference the
// production by loose ID in their own contexts. RLS enabled on all five;
// runtime grants are explicit per-table in migration 0011 — arwd on the two
// mutable aggregates, INSERT+SELECT only on the three immutable families
// (D2.6-4, the audit_log pattern).
// ---------------------------------------------------------------------------

/**
 * Aggregate root 4 (DM section 31): a container for productions inside one
 * organization. Slug is unique PER ORG (like teams; unlike the globally
 * unique organization slug).
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => operators.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("projects_status_check", sql`${t.status} in ('active', 'archived')`),
    unique("projects_org_slug_unique").on(t.orgId, t.slug),
    index("idx_projects_org").on(t.orgId),
  ],
).enableRLS();

/**
 * Aggregate root 5 (DM section 31): the production lifecycle. Status carries
 * the approved DOMAIN_MODEL section 32 state machine (explicit CHECK; no
 * invented states). Plan/manifest pointers are version-family rows (DM
 * section 33: immutable version rows + current pointer on the owner).
 */
export const productions = pgTable(
  "productions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    /** Null until the first plan version is recorded. */
    currentPlanVersionId: uuid("current_plan_version_id"),
    /** The production's current approved manifest version ref (nullable until issued). */
    currentManifestVersionId: uuid("current_manifest_version_id"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      // DOMAIN_MODEL section 32 state machine 1 — no invented states; the
      // on_hold return path is a state, not an edge, so it is representable.
      "productions_status_check",
      sql`${t.status} in (
        'draft', 'planning', 'in_gate', 'approved', 'queued', 'in_production',
        'post_production', 'qc', 'ready_for_publication', 'published', 'archived',
        'on_hold', 'changes_requested', 'cancelled'
      )`,
    ),
    index("idx_productions_org").on(t.orgId),
    index("idx_productions_project").on(t.projectId),
  ],
).enableRLS();

/**
 * Append-only plan version family (DM section 33: immutable version rows + a
 * current pointer on the owning entity). Any material change creates a new
 * row; nothing is updated or deleted (D2.6-4 grants: INSERT+SELECT only).
 * The plan document is schema-validated inline jsonb (D2.6-2); script binaries
 * remain a later-stage decision (DM Open Question 8 untouched).
 */
export const productionPlanVersions = pgTable(
  "production_plan_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    productionId: uuid("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    /** Schema-validated @stratifit/contracts ProductionPlanDocument (D2.6-2). */
    planDocument: jsonb("plan_document").$type<Record<string, unknown>>().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => operators.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("production_plan_versions_version_number_check", sql`${t.versionNumber} > 0`),
    unique("production_plan_versions_production_version_unique").on(t.productionId, t.versionNumber),
    index("idx_production_plan_versions_production").on(t.productionId),
  ],
).enableRLS();

/**
 * Append-only gate decision family (DM section 7: "The persisted artifact is
 * the Gate Decision Record (immutable)"). Each row snapshots the gate inputs
 * and outcome for one plan version; approval (invariant 1) requires a row
 * whose decision is 'pass' for the production's current plan version.
 */
export const gateDecisionRecords = pgTable(
  "gate_decision_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    productionId: uuid("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => productionPlanVersions.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    /** Snapshot of the gate inputs (budget, moderation-planned) at evaluation. */
    inputsSnapshot: jsonb("inputs_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    /** Structured gate issues when the evaluation did not pass. */
    issues: jsonb("issues").$type<Record<string, unknown>[]>().notNull().default([]),
    evaluatedBy: uuid("evaluated_by")
      .notNull()
      .references(() => operators.id, { onDelete: "restrict" }),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("gate_decision_records_decision_check", sql`${t.decision} in ('pass', 'fail')`),
    index("idx_gate_decision_records_production").on(t.productionId),
    index("idx_gate_decision_records_plan_version").on(t.planVersionId),
  ],
).enableRLS();

/**
 * Append-only manifest version family (DM section 7: "immutable once
 * approved"). Each row stores one ProductionManifest document built by the
 * existing manifest builder at approval/issuance time.
 */
export const manifestVersions = pgTable(
  "manifest_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    productionId: uuid("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => productionPlanVersions.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    /** The ProductionManifest contract document (packages/contracts manifest.ts). */
    manifestDocument: jsonb("manifest_document").$type<Record<string, unknown>>().notNull(),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => operators.id, { onDelete: "restrict" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("manifest_versions_version_number_check", sql`${t.versionNumber} > 0`),
    unique("manifest_versions_production_version_unique").on(t.productionId, t.versionNumber),
    index("idx_manifest_versions_production").on(t.productionId),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Job / Compute domain (Stage 2.7, approved decisions D2.7-1..D2.7-5)
//
// Conceptual owner: services/jobs (SVC section 11 context 9). Tenancy per D1:
// org_id NOT NULL on every table. Cross-module rule (D2): the only FKs are
// intra-family (job -> job) plus organizations; subjects (manifests,
// generations, publications) are referenced by loose ID in their own
// contexts. D2.7-4: no worker/lease tables; attempts are recorded immutably.
// D2.7-5: these tables ARE the durable state — no outbox tables exist.
// RLS enabled on all five; runtime grants are explicit per-table in
// migration 0013 — arwd on the four mutable families, INSERT+SELECT only on
// the immutable attempt history (the audit_log pattern).
// ---------------------------------------------------------------------------

/** D2.7-3: the complete documented job type catalog (DM section 16). */
export const JOB_TYPES = [
  "generation.execute",
  "media.process",
  "publication.deliver",
  "notification.send",
  "qc.run",
] as const;

/**
 * Aggregate root 17 (DM section 16): one unit of executable work. Status
 * carries the DM section 32 state machine 2 as an explicit CHECK (no
 * invented states). Idempotency per invariant 7: UNIQUE (org, type, key) —
 * retries dedupe on the key and duplicate enqueues resolve to the existing
 * job.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    jobType: text("job_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Loose subject reference (what the work acts on) — no cross-module FK. */
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** Production manifest version ref (nullable — not every job has one). */
    manifestRef: uuid("manifest_ref"),
    computeRequirementId: uuid("compute_requirement_id"),
    status: text("status").notNull().default("created"),
    priority: integer("priority").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    attemptCount: integer("attempt_count").notNull().default(0),
    progress: integer("progress").notNull().default(0),
    lastError: text("last_error"),
    /** Cancellation overlay (DM section 32.2) — observed at safe points. */
    cancellationRequested: boolean("cancellation_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "jobs_type_check",
      sql`${t.jobType} in ('generation.execute', 'media.process', 'publication.deliver', 'notification.send', 'qc.run')`,
    ),
    check(
      "jobs_status_check",
      sql`${t.status} in ('created', 'queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check("jobs_max_attempts_check", sql`${t.maxAttempts} > 0`),
    check("jobs_progress_check", sql`${t.progress} between 0 and 100`),
    // Invariant 7: idempotency key is unique per org + type. Different orgs
    // may reuse the same key; a duplicate enqueue resolves to this row.
    unique("jobs_org_type_key_unique").on(t.orgId, t.jobType, t.idempotencyKey),
    index("idx_jobs_org_status").on(t.orgId, t.status),
    index("idx_jobs_org_subject").on(t.orgId, t.subjectKind, t.subjectId),
  ],
).enableRLS();

/**
 * DAG edges: job B starts after job A reaches a terminal state. Self
 * dependency is forbidden at the schema level; cross-org edges and cycles
 * are rejected in the service BEFORE insert (D2.7-4: no scheduler tables).
 */
export const jobDependencies = pgTable(
  "job_dependencies",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    dependsOnJobId: uuid("depends_on_job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("job_dependencies_no_self_check", sql`${t.jobId} <> ${t.dependsOnJobId}`),
    // Same-org enforcement is a BEFORE-INSERT trigger (migration 0013):
    // PostgreSQL does not allow subqueries in CHECK constraints, and both
    // endpoints already share the org through their jobs FKs.
    primaryKey({ name: "job_dependencies_pk", columns: [t.jobId, t.dependsOnJobId] }),
    index("idx_job_dependencies_depends_on").on(t.dependsOnJobId),
  ],
).enableRLS();

/**
 * Append-only attempt history (DM section 16: "attempts are recorded
 * immutably"). worker_ref is a platform-agnostic identity string — worker
 * credentials are NEVER stored (invariant 4). Runtime privileges are
 * INSERT+SELECT only (migration 0013): UPDATE/DELETE are unrepresentable.
 */
export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    /** Platform-agnostic worker identity — never credentials (invariant 4). */
    workerRef: text("worker_ref").notNull(),
    allocationRef: text("allocation_ref"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    outcome: text("outcome"),
    errorDetail: text("error_detail"),
    /** Resume-support progress snapshots (DM section 16). */
    progressSnapshot: jsonb("progress_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    usageRecordId: uuid("usage_record_id"),
  },
  (t) => [
    check(
      "job_attempts_outcome_check",
      sql`${t.outcome} is null or ${t.outcome} in ('succeeded', 'failed', 'timed_out', 'cancelled')`,
    ),
    check("job_attempts_attempt_number_check", sql`${t.attemptNumber} > 0`),
    unique("job_attempts_job_attempt_unique").on(t.jobId, t.attemptNumber),
    index("idx_job_attempts_job").on(t.jobId),
  ],
).enableRLS();

/**
 * Pure estimate structure mirroring packages/compute ComputeAllocationRequest
 * (DM section 16: "pure estimate structure") plus its org scope. No provider
 * activation, no credentials — records only.
 */
export const computeRequirements = pgTable(
  "compute_requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    gpuClass: text("gpu_class").notNull(),
    vramGb: integer("vram_gb").notNull(),
    workers: integer("workers").notNull(),
    concurrency: integer("concurrency").notNull(),
    estimatedRuntimeSeconds: integer("estimated_runtime_seconds").notNull(),
    storageMb: integer("storage_mb").notNull(),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "compute_requirements_positive_check",
      sql`${t.vramGb} >= 0 and ${t.workers} > 0 and ${t.concurrency} > 0 and ${t.estimatedRuntimeSeconds} >= 0 and ${t.storageMb} >= 0`,
    ),
    index("idx_compute_requirements_org").on(t.orgId),
  ],
).enableRLS();

/**
 * Actuals captured against an allocation (DM section 16) so estimates improve
 * against actuals over time. No provider credentials — references only.
 */
export const computeUsage = pgTable(
  "compute_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    allocationRef: text("allocation_ref").notNull(),
    actualRuntimeSeconds: integer("actual_runtime_seconds").notNull(),
    actualCostUsd: numeric("actual_cost_usd", { precision: 12, scale: 4 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("compute_usage_positive_check", sql`${t.actualRuntimeSeconds} >= 0 and ${t.actualCostUsd} >= 0`),
    index("idx_compute_usage_org").on(t.orgId),
  ],
).enableRLS();

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type JobDependencyRow = typeof jobDependencies.$inferSelect;
export type NewJobDependencyRow = typeof jobDependencies.$inferInsert;
export type JobAttemptRow = typeof jobAttempts.$inferSelect;
export type NewJobAttemptRow = typeof jobAttempts.$inferInsert;
export type ComputeRequirementRow = typeof computeRequirements.$inferSelect;
export type NewComputeRequirementRow = typeof computeRequirements.$inferInsert;
export type ComputeUsageRow = typeof computeUsage.$inferSelect;
export type NewComputeUsageRow = typeof computeUsage.$inferInsert;

/**
 * Catalog (Model/Workflow) — Stage 2.8 (bounded context 8, aggregates 15/16).
 *
 * SERVICE_ARCHITECTURE section 11 context 8 assigns the durable rows
 * (models, model_versions, workflows, workflow_versions) to packages/ai and
 * packages/workflows via packages/database repositories. DOMAIN_MODEL
 * section 14/15: vendor/runtime identifiers are platform-agnostic REFERENCES
 * (adapter_ref / runtime_ref), never provider concepts (invariant 20);
 * credentials never appear here (invariant 4).
 *
 * PRIVILEGE MODEL (migration 0016, the 0009/0011/0013 append-only pattern):
 *   - models, workflows (mutable parents): runtime ARWD;
 *   - model_versions, workflow_versions (immutable version families —
 *     DM section 33 "immutable version rows", "historical versions are never
 *     deleted or rewritten"): INSERT + SELECT ONLY.
 */

/** Capability-kind allowlist — mirrors packages/contracts CAPABILITY_KINDS. */
export const MODEL_CAPABILITY_KINDS = [
  "image.generation",
  "video.generation",
  "voice.synthesis",
  "music.generation",
  "audio",
  "lip.sync",
  "sfx",
  "vfx",
  "enhancement",
] as const;

/**
 * Aggregate root 15: one registered AI capability entry point. Registry
 * status follows DM section 14 (`active` / `deprecated` / `disabled`);
 * transitions are guarded in the service, not here (a plain status column).
 * vendor_label is operator-UI display metadata only — never a domain concept.
 */
export const models = pgTable(
  "models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    capabilityKind: text("capability_kind").notNull(),
    displayName: text("display_name").notNull(),
    /** Platform-agnostic vendor label for operator UIs — never a provider ref. */
    vendorLabel: text("vendor_label").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "models_capability_kind_check",
      sql`${t.capabilityKind} in ('image.generation', 'video.generation', 'voice.synthesis', 'music.generation', 'audio', 'lip.sync', 'sfx', 'vfx', 'enhancement')`,
    ),
    check("models_status_check", sql`${t.status} in ('active', 'deprecated', 'disabled')`),
    unique("models_org_name_unique").on(t.orgId, t.name),
    index("idx_models_org_status").on(t.orgId, t.status),
    index("idx_models_org_capability").on(t.orgId, t.capabilityKind),
  ],
).enableRLS();

/**
 * Immutable model version (DM section 14): registered once, never edited or
 * deleted. adapter_ref identifies the registered adapter implementation
 * (packages/ai) — a platform-agnostic identifier, never credentials.
 * compatibilities are metadata evaluated by the planner/gate — never vendor
 * logic in the domain.
 */
export const modelVersions = pgTable(
  "model_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "restrict" }),
    version: text("version").notNull(),
    /** Platform-agnostic adapter identifier (packages/ai registry key). */
    adapterRef: text("adapter_ref").notNull(),
    /** Input/output kinds and constraints (max resolution/duration). */
    compatibility: jsonb("compatibility").$type<Record<string, unknown>>().notNull().default({}),
    defaultParameters: jsonb("default_parameters").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("active"),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("model_versions_status_check", sql`${t.status} in ('active', 'deprecated', 'disabled')`),
    unique("model_versions_org_model_version_unique").on(t.orgId, t.modelId, t.version),
    index("idx_model_versions_model").on(t.modelId),
  ],
).enableRLS();

/**
 * Aggregate root 16: one registered workflow entry point. `supports` is a
 * JSON array of capability kinds (service-validated against the same
 * allowlist); historical workflow versions are never deleted or rewritten
 * (DM section 15).
 */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    supports: jsonb("supports").$type<readonly string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("workflows_status_check", sql`${t.status} in ('active', 'deprecated', 'disabled')`),
    unique("workflows_org_name_unique").on(t.orgId, t.name),
    index("idx_workflows_org_status").on(t.orgId, t.status),
  ],
).enableRLS();

/**
 * Immutable workflow version (DM section 15). runtime_ref is a
 * platform-agnostic runtime-TYPE identifier (ComfyUI is one such runtime
 * behind the abstraction, not a domain concept). definition is the opaque,
 * schema-validated definition payload (D2.8-2: jsonb column) interpreted by
 * the runtime — never credentials, never a provider concept.
 */
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "restrict" }),
    version: text("version").notNull(),
    /** Platform-agnostic runtime-type identifier. */
    runtimeRef: text("runtime_ref").notNull(),
    /** Opaque runtime-interpreted definition payload (D2.8-2). */
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull().default({}),
    compatibility: jsonb("compatibility").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("active"),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("workflow_versions_status_check", sql`${t.status} in ('active', 'deprecated', 'disabled')`),
    unique("workflow_versions_org_workflow_version_unique").on(t.orgId, t.workflowId, t.version),
    index("idx_workflow_versions_workflow").on(t.workflowId),
  ],
).enableRLS();

export type ModelRow = typeof models.$inferSelect;
export type NewModelRow = typeof models.$inferInsert;
export type ModelVersionRow = typeof modelVersions.$inferSelect;
export type NewModelVersionRow = typeof modelVersions.$inferInsert;
export type WorkflowRow = typeof workflows.$inferSelect;
export type NewWorkflowRow = typeof workflows.$inferInsert;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type NewWorkflowVersionRow = typeof workflowVersions.$inferInsert;
