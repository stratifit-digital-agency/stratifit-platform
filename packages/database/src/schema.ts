import { sql } from "drizzle-orm";
import {
  bigint,
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
  type AnyPgColumn,
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

// ---------------------------------------------------------------------------
// Generation domain (Stage 2.9, approved decisions D2.9-1..D2.9-4)
//
// Conceptual owner: services/generation (SVC section 11 context 7). Tenancy
// per D1: org_id NOT NULL on every table. Cross-module rule (D2): production/
// scene/shot/job/output-asset stay LOOSE references — no FKs to other module
// families; the only FKs are intra-family (generations -> generations for
// lineage) plus organizations. Catalog versions are pinned UUIDs (invariants
// 8/9) resolved by the generation service — not enforced by FK (the catalog
// families live in another bounded context; same-org consistency is
// validated by the service at request time).
//
// PRIVILEGE MODEL (migration 0018, the 0009/0011/0013/0016 append-only
// pattern):
//   - generations (mutable lifecycle aggregate): SELECT + INSERT + UPDATE
//     + DELETE for stratifit_runtime;
//   - generation_provenance (immutable completion record — DM section 13
//     "historical provenance is immutable", invariant 3, DM section 34
//     "written once"): INSERT + SELECT ONLY. UPDATE and DELETE are NEVER
//     granted and no UPDATE/DELETE policy exists.
// D2.9-4: no Generation -> Jobs wiring exists; job_id is a loose column the
// production path may set later through its own approved increment.
// ---------------------------------------------------------------------------

/** DM section 32.3: the complete generation lifecycle (all terminal). */
export const GENERATION_STATUSES = [
  "requested",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

/**
 * Aggregate root 14 (DM section 13/31): one AI execution request. Status
 * carries the DM section 32.3 state machine as an explicit CHECK (no
 * invented states). Request provenance (prompt, seed, parameters, requested
 * spec, estimated cost) is written at INSERT and NEVER updated by any
 * command (invariant 3: corrections are superseding records — new
 * generations via parent lineage, never edits). Idempotency per the
 * API_ARCHITECTURE generation card: UNIQUE (org, request_key); a duplicate
 * request resolves to the existing generation.
 */
export const generations = pgTable(
  "generations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("requested"),
    /** Loose cross-module refs (approved D2) — no FKs to other families. */
    productionId: uuid("production_id"),
    sceneId: uuid("scene_id"),
    shotId: uuid("shot_id"),
    /** D2.9-4: loose job reference only — no wiring, no FK. */
    jobId: uuid("job_id"),
    /** Set at completion; assets stay a loose reference (no assets family yet). */
    outputAssetVersionId: uuid("output_asset_version_id"),
    /** Pinned Catalog resolution (invariants 8/9) — loose UUIDs, service-validated. */
    modelId: uuid("model_id").notNull(),
    modelVersionId: uuid("model_version_id").notNull(),
    workflowId: uuid("workflow_id"),
    workflowVersionId: uuid("workflow_version_id"),
    /** Lineage DAG via parent references; parents are never mutated. */
    parentGenerationId: uuid("parent_generation_id").references((): AnyPgColumn => generations.id, {
      onDelete: "restrict",
    }),
    /** Request provenance — INSERT-only semantics, never command-mutable. */
    inputAssetVersionIds: jsonb("input_asset_version_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt"),
    seed: text("seed"),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    resolution: text("resolution"),
    fps: integer("fps"),
    durationSeconds: numeric("duration_seconds", { precision: 10, scale: 3 }),
    adapters: jsonb("adapters").$type<Record<string, unknown>[]>().notNull().default([]),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 4 }),
    /** API_ARCHITECTURE generation card: idempotency key per request. */
    requestKey: text("request_key"),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "generations_status_check",
      sql`${t.status} in ('requested', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    // API_ARCHITECTURE: duplicate generation requests dedupe on the key.
    unique("generations_org_request_key_unique").on(t.orgId, t.requestKey),
    index("idx_generations_org_status").on(t.orgId, t.status),
    index("idx_generations_org_production").on(t.orgId, t.productionId),
  ],
).enableRLS();

/**
 * Immutable completion provenance (D2.9-1): ONE row per generation, written
 * once by completeGeneration in the same transaction as the status
 * transition. generation_id is the PRIMARY KEY — the uniqueness IS the
 * one-shot guard (a second completion hits 23505). No updatedAt column.
 * worker_ref / gpu_class are platform-agnostic identifiers — never
 * credentials (invariant 4).
 */
export const generationProvenance = pgTable(
  "generation_provenance",
  {
    generationId: uuid("generation_id")
      .primaryKey()
      .references(() => generations.id, { onDelete: "restrict" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Output storage reference — the existing `generations` key namespace. */
    outputStorageKey: text("output_storage_key"),
    outputChecksum: text("output_checksum"),
    outputByteSize: bigint("output_byte_size", { mode: "number" }),
    executedSeed: text("executed_seed"),
    /** Platform-agnostic identifiers only — NEVER credentials (invariant 4). */
    workerRef: text("worker_ref"),
    gpuClass: text("gpu_class"),
    runtimeVersion: text("runtime_version"),
    actualCostUsd: numeric("actual_cost_usd", { precision: 12, scale: 4 }),
    actualRuntimeSeconds: integer("actual_runtime_seconds"),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_generation_provenance_org").on(t.orgId)],
).enableRLS();

//
// ---------------------------------------------------------------------------
// ASSET DOMAIN (Stage 2.10) — bounded context 6 (SVC section 11), DM section
// 12/32.4. Owned by services/assets (module placed in services/ per the
// approved Stage 2.10 plan; the domain families here are its durable rows).
//
// PRIVILEGE MODEL (migration 0020, the 0009/0011/0013/0016/0018 append-only
// pattern):
//   - assets (mutable lifecycle aggregate, D2.10-1: approval state lives
//     HERE, not on immutable versions): SELECT + INSERT + UPDATE + DELETE
//     for stratifit_runtime;
//   - asset_versions (immutable version family — DM section 12 "Asset
//     Version (immutable)" / invariant 24): INSERT + SELECT ONLY;
//   - asset_lineage (immutable DAG edges — DM section 12 / invariant 25):
//     INSERT + SELECT ONLY. UPDATE and DELETE are NEVER granted and no
//     UPDATE/DELETE policy exists.
// D2.10-5: lineage reads are single-hop only; no traversal infrastructure.
// The lineage DAG cycle defense mirrors the Stage 2.7 jobs precedent:
// edges are only added alongside newly created versions, so no cycle is
// constructible through the service API; the DB constraints are
// defense-in-depth.
// ---------------------------------------------------------------------------

/** DM section 12: the approved asset-kind taxonomy (no invented kinds). */
export const ASSET_KINDS = ["video", "audio", "image", "document", "subtitle", "data"] as const;

/** DM section 12: asset subtypes (exact architecture terminology). */
export const ASSET_SUBTYPES = [
  "master",
  "derivative",
  "thumbnail",
  "poster",
  "trailer",
  "clip",
  "sample",
  "subtitle",
  "lyrics",
  "caption",
  "document",
] as const;

/** DM section 12: asset approval state (the D2.10-1 mutable aggregate state). */
export const ASSET_APPROVAL_STATES = ["pending", "in_review", "approved", "rejected"] as const;

/** DM section 12: visibility — public visibility is granted at PUBLICATION. */
export const ASSET_VISIBILITIES = ["internal", "public"] as const;

/** DM section 12: lineage derivation kinds (relationship metadata only). */
export const ASSET_DERIVATION_KINDS = [
  "generation",
  "edit",
  "transcode",
  "thumbnail",
  "trailer",
  "upscale",
  "enhancement",
] as const;

/**
 * Aggregate root 13 (DM section 12): a managed media item. The database
 * stores metadata + storage references; binaries live in object storage
 * (invariant 21 — large binaries never transit PostgreSQL). D2.10-1: the
 * approval state machine (DM section 32.4) lives on THIS mutable aggregate;
 * asset_versions stay immutable. `currentVersionId` is the only mutable
 * version reference (invariant 24). Visibility stays `internal` until a
 * publication grants public visibility — never by flipping a flag here.
 */
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    subtype: text("subtype"),
    title: text("title").notNull(),
    description: text("description"),
    /** Null until the first version is registered (production pointer precedent). */
    currentVersionId: uuid("current_version_id"),
    /** D2.10-1: the DM section 32.4 approval state machine lives on the aggregate. */
    approvalState: text("approval_state").notNull().default("pending"),
    visibility: text("visibility").notNull().default("internal"),
    /** Loose cross-module refs (approved D2) — no FKs to other families. */
    productionId: uuid("production_id"),
    shotId: uuid("shot_id"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("assets_kind_check", sql`${t.kind} in ('video', 'audio', 'image', 'document', 'subtitle', 'data')`),
    check(
      "assets_subtype_check",
      sql`${t.subtype} is null or ${t.subtype} in ('master', 'derivative', 'thumbnail', 'poster', 'trailer', 'clip', 'sample', 'subtitle', 'lyrics', 'caption', 'document')`,
    ),
    check(
      "assets_approval_state_check",
      sql`${t.approvalState} in ('pending', 'in_review', 'approved', 'rejected')`,
    ),
    check("assets_visibility_check", sql`${t.visibility} in ('internal', 'public')`),
    index("idx_assets_org_kind").on(t.orgId, t.kind),
    index("idx_assets_org_status").on(t.orgId, t.approvalState),
    index("idx_assets_org_production").on(t.orgId, t.productionId),
  ],
).enableRLS();

/**
 * Immutable asset version (DM section 12 "Asset Version (immutable)";
 * invariant 24: versioned entities mutate only by appending new versions).
 * StorageRef-compatible metadata (bucket/key/checksum/byteSize/mimeType)
 * mirrors DATA_FLOW section 11 exactly. `provenanceGenerationId` is a
 * metadata-only reference to the Stage 2.9 generation family — no reverse
 * wiring exists (Generation does not depend on Assets, and Assets does not
 * invoke Generation). No updatedAt column exists (immutability at the
 * schema level).
 */
export const assetVersions = pgTable(
  "asset_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    assetId: uuid("asset_id")
      .notNull()
      .references((): AnyPgColumn => assets.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    /** StorageRef metadata (DATA_FLOW section 11) — references, never binaries. */
    bucket: text("bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    checksum: text("checksum").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    /** Technical metadata (resolution, fps, duration, codec, sample rate). */
    technicalMetadata: jsonb("technical_metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Provenance metadata reference into the Stage 2.9 generation family. */
    provenanceGenerationId: uuid("provenance_generation_id"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("asset_versions_org_asset_version_unique").on(t.orgId, t.assetId, t.versionNumber),
    index("idx_asset_versions_org_asset").on(t.orgId, t.assetId),
  ],
).enableRLS();

/**
 * Immutable lineage edges (DM section 12 "Asset lineage DAG"; invariant 25:
 * cycles and parent rewrites are rejected). parent_version_id =
 * child_version_id is structurally impossible via the self-edge CHECK. Rows
 * are INSERT-only at the privilege layer; the edge unique constraint is the
 * duplicate-edge backstop. The cycle defense follows the Stage 2.7 jobs
 * precedent: edges are only added alongside newly registered versions, so
 * no cycle is constructible through the service API.
 */
export const assetLineage = pgTable(
  "asset_lineage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    parentVersionId: uuid("parent_version_id")
      .notNull()
      .references((): AnyPgColumn => assetVersions.id, { onDelete: "restrict" }),
    childVersionId: uuid("child_version_id")
      .notNull()
      .references((): AnyPgColumn => assetVersions.id, { onDelete: "restrict" }),
    derivationKind: text("derivation_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "asset_lineage_derivation_kind_check",
      sql`${t.derivationKind} in ('generation', 'edit', 'transcode', 'thumbnail', 'trailer', 'upscale', 'enhancement')`,
    ),
    // Invariant 25: a version is never its own parent.
    check("asset_lineage_no_self_edge_check", sql`${t.parentVersionId} <> ${t.childVersionId}`),
    unique("asset_lineage_edge_unique").on(t.parentVersionId, t.childVersionId),
    index("idx_asset_lineage_org_child").on(t.orgId, t.childVersionId),
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
export type GenerationRow = typeof generations.$inferSelect;
export type NewGenerationRow = typeof generations.$inferInsert;
export type GenerationProvenanceRow = typeof generationProvenance.$inferSelect;
export type NewGenerationProvenanceRow = typeof generationProvenance.$inferInsert;
export type AssetRow = typeof assets.$inferSelect;
export type NewAssetRow = typeof assets.$inferInsert;
export type AssetVersionRow = typeof assetVersions.$inferSelect;
export type NewAssetVersionRow = typeof assetVersions.$inferInsert;
export type AssetLineageRow = typeof assetLineage.$inferSelect;
export type NewAssetLineageRow = typeof assetLineage.$inferInsert;

/**
 * QC subject kinds (DM section 18: "subject ref + kind (asset version |
 * generation | production | publication)").
 */
export const QC_SUBJECT_KINDS = ["asset_version", "generation", "production", "publication"] as const;
export const QC_CHECK_TYPES = ["technical", "moderation", "rights", "editorial"] as const;
/** D2.11-7: exactly active | archived. Archived checks cannot attach new results. */
export const QC_CHECK_STATUSES = ["active", "archived"] as const;
/** DM section 32.5 QC Review state machine — no other states exist. */
export const QC_REVIEW_STATUSES = ["pending", "in_review", "approved", "rejected", "changes_requested"] as const;
export const QC_DECISIONS = ["approve", "reject", "changes_requested"] as const;
export const QC_OUTCOMES = ["pass", "fail", "warn", "skipped"] as const;
export const QC_EVALUATED_BY = ["human", "automated"] as const;
export const QC_SEVERITIES = ["blocker", "major", "minor", "note"] as const;
export const QC_ISSUE_RESOLUTIONS = ["open", "resolved", "waived"] as const;

/**
 * QC check definition (DM section 18 "QC Check (definition)"). Mutable:
 * definitions evolve; the results they produced never do. Archived checks
 * remain historical/readable but cannot be attached to new results
 * (D2.11-7).
 */
export const qcChecks = pgTable(
  "qc_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    appliesToKind: text("applies_to_kind").notNull(),
    checkType: text("check_type").notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    required: boolean("required").notNull().default(true),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("qc_checks_org_name_unique").on(t.orgId, t.name),
    check(
      "qc_checks_applies_to_kind_check",
      sql`${t.appliesToKind} in ('asset_version', 'generation', 'production', 'publication')`,
    ),
    check(
      "qc_checks_check_type_check",
      sql`${t.checkType} in ('technical', 'moderation', 'rights', 'editorial')`,
    ),
    // D2.11-7: exactly active | archived.
    check("qc_checks_status_check", sql`${t.status} in ('active', 'archived')`),
    index("idx_qc_checks_org_applies").on(t.orgId, t.appliesToKind),
  ],
).enableRLS();

/**
 * Per-subject QC review (DM section 18 "Review / Approval / Rejection" and
 * section 32.5). One lifecycle per subject: UNIQUE(org, subject_kind,
 * subject_ref) — a superseding asset version is a NEW subject_ref and gets
 * a fresh review. subject_ref stays a LOOSE cross-module UUID (approved
 * D2.11-2): zero cross-context foreign keys; organization ownership of the
 * subject is validated by the service through narrow read-only upstream
 * lookup ports. publication subjects are structurally supported but FAIL
 * CLOSED until durable Publishing exists.
 */
export const qcReviews = pgTable(
  "qc_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subjectKind: text("subject_kind").notNull(),
    subjectRef: uuid("subject_ref").notNull(),
    status: text("status").notNull().default("pending"),
    requestedBy: uuid("requested_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("qc_reviews_org_subject_unique").on(t.orgId, t.subjectKind, t.subjectRef),
    check(
      "qc_reviews_subject_kind_check",
      sql`${t.subjectKind} in ('asset_version', 'generation', 'production', 'publication')`,
    ),
    check(
      "qc_reviews_status_check",
      sql`${t.status} in ('pending', 'in_review', 'approved', 'rejected', 'changes_requested')`,
    ),
    index("idx_qc_reviews_org_status").on(t.orgId, t.status),
  ],
).enableRLS();

/**
 * Immutable decision record (DM section 18: "the decision record is
 * immutable and linkable to the operator identity and capability check";
 * invariant 3: corrections are superseding records, never edits). Appended
 * in the SAME transaction as the review state transition it produced. No
 * updatedAt column exists (immutability at the schema level).
 */
export const qcReviewDecisions = pgTable(
  "qc_review_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    reviewId: uuid("review_id")
      .notNull()
      .references((): AnyPgColumn => qcReviews.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    reviewerOperatorId: uuid("reviewer_operator_id").notNull(),
    reason: text("reason"),
    capabilityUsed: text("capability_used").notNull().default("production.approve"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "qc_review_decisions_decision_check",
      sql`${t.decision} in ('approve', 'reject', 'changes_requested')`,
    ),
    index("idx_qc_review_decisions_org_review").on(t.orgId, t.reviewId),
  ],
).enableRLS();

/**
 * Immutable check result (DM section 18 "QC Result (immutable)").
 * Append-only history: multiple results for the same (review, check) are
 * allowed and never overwritten; eligibility reads the LATEST result by
 * (evaluated_at DESC, id DESC). No updatedAt column exists.
 */
export const qcResults = pgTable(
  "qc_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    reviewId: uuid("review_id")
      .notNull()
      .references((): AnyPgColumn => qcReviews.id, { onDelete: "restrict" }),
    checkId: uuid("check_id")
      .notNull()
      .references((): AnyPgColumn => qcChecks.id, { onDelete: "restrict" }),
    outcome: text("outcome").notNull(),
    evaluatedBy: text("evaluated_by").notNull(),
    ruleRef: text("rule_ref"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("qc_results_outcome_check", sql`${t.outcome} in ('pass', 'fail', 'warn', 'skipped')`),
    check("qc_results_evaluated_by_check", sql`${t.evaluatedBy} in ('human', 'automated')`),
    index("idx_qc_results_org_review").on(t.orgId, t.reviewId),
    index("idx_qc_results_review_check").on(t.reviewId, t.checkId),
  ],
).enableRLS();

/**
 * QC issue (DM section 18): severity + resolution lifecycle on a mutable
 * row. Resolution is the approved mutable lifecycle (open → resolved |
 * waived, resolved_by recorded); deterministic re-resolution conflicts are
 * rejected at the service layer.
 */
export const qcIssues = pgTable(
  "qc_issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    resultId: uuid("result_id")
      .notNull()
      .references((): AnyPgColumn => qcResults.id, { onDelete: "restrict" }),
    severity: text("severity").notNull(),
    description: text("description").notNull(),
    resolution: text("resolution").notNull().default("open"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "qc_issues_severity_check",
      sql`${t.severity} in ('blocker', 'major', 'minor', 'note')`,
    ),
    check("qc_issues_resolution_check", sql`${t.resolution} in ('open', 'resolved', 'waived')`),
    index("idx_qc_issues_org_result").on(t.orgId, t.resultId),
    index("idx_qc_issues_org_resolution").on(t.orgId, t.resolution),
  ],
).enableRLS();

export type QcCheckRow = typeof qcChecks.$inferSelect;
export type NewQcCheckRow = typeof qcChecks.$inferInsert;
export type QcReviewRow = typeof qcReviews.$inferSelect;
export type NewQcReviewRow = typeof qcReviews.$inferInsert;
export type QcReviewDecisionRow = typeof qcReviewDecisions.$inferSelect;
export type NewQcReviewDecisionRow = typeof qcReviewDecisions.$inferInsert;
export type QcResultRow = typeof qcResults.$inferSelect;
export type NewQcResultRow = typeof qcResults.$inferInsert;
export type QcIssueRow = typeof qcIssues.$inferSelect;
export type NewQcIssueRow = typeof qcIssues.$inferInsert;

/**
 * PUBLISHING bounded context (context 11, SVC section 11) — Stage 2.12.
 *
 * Publication (mutable aggregate root), Publication Version (immutable
 * snapshot family), Distribution Reference (immutable attempt record).
 * subject_ref stays a LOOSE cross-module UUID (approved D2.12-D): zero
 * cross-context foreign keys; ownership is validated by the service through
 * narrow read-only upstream lookup ports (production, asset_version durably;
 * ai_creator_profile / campaign_creative structurally supported but FAIL
 * CLOSED until their bounded contexts exist).
 *
 * D2.12-C: full DM section 32.6 lifecycle draft → pending_approval →
 * approved → scheduled → publishing → published → unpublished, failure path
 * publishing → failed, retry failed → pending_approval. A publish failure
 * NEVER invalidates the underlying master asset/production (invariant 5) —
 * this service owns only Publishing state.
 */
export const publications = pgTable(
  "publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subjectKind: text("subject_kind").notNull(),
    subjectRef: uuid("subject_ref").notNull(),
    platformTarget: text("platform_target").notNull(),
    contentType: text("content_type").notNull(),
    /** Current immutable version pointer. */
    currentVersionId: uuid("current_version_id"),
    /**
     * The approval-time QC review whose approved state gates publication —
     * the FROZEN location for the QC approval reference (the immutable
     * version snapshot stays within its exact contracted shape).
     */
    qcReviewId: uuid("qc_review_id"),
    /** DM section 32.6 lifecycle; service-enforced transitions. */
    status: text("status").notNull().default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    /** Retry bookkeeping for the publishing → failed → pending_approval path. */
    attemptCount: integer("attempt_count").notNull().default(0),
    lastFailureReason: text("last_failure_reason"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One publication per subject + platform (a different platform = a new row).
    unique("publications_org_subject_platform_unique").on(
      t.orgId,
      t.subjectKind,
      t.subjectRef,
      t.platformTarget,
    ),
    check(
      "publications_subject_kind_check",
      sql`${t.subjectKind} in ('production', 'asset_version', 'ai_creator_profile', 'campaign_creative')`,
    ),
    check(
      "publications_platform_target_check",
      sql`${t.platformTarget} in ('stratifit-media', 'youtube', 'tiktok', 'instagram', 'facebook')`,
    ),
    // D2.12-B: narrow Stage-1 taxonomy retained; expands with the public
    // content model in the Audience phase.
    check(
      "publications_content_type_check",
      sql`${t.contentType} in ('film', 'series', 'episode', 'short', 'music', 'documentary', 'trailer')`,
    ),
    // D2.12-C: exactly the DM section 32.6 states.
    check(
      "publications_status_check",
      sql`${t.status} in ('draft', 'pending_approval', 'approved', 'scheduled', 'publishing', 'published', 'unpublished', 'failed')`,
    ),
    index("idx_publications_org_status").on(t.orgId, t.status),
    index("idx_publications_org_subject").on(t.orgId, t.subjectKind, t.subjectRef),
  ],
).enableRLS();

/**
 * Immutable publication snapshot ("a correction is a NEW version, never an
 * overwrite" — DM section 33). Created at publication create (v1) and at
 * revise (draft-only). The shape is the EXACT frozen Stage 2.12 contract:
 * identity, content fields, subject reference, and actor — nothing else. No
 * qc_review_id (the approval-time QC reference lives on the publication),
 * no subject_snapshot, no platform_target (inherited from the publication).
 * Runtime grants: INSERT + SELECT only; live 42501 proofs for UPDATE/DELETE.
 */
export const publicationVersions = pgTable(
  "publication_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    publicationId: uuid("publication_id")
      .notNull()
      .references((): AnyPgColumn => publications.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    synopsis: text("synopsis"),
    contentType: text("content_type").notNull(),
    /** Frozen subject reference carried on the immutable snapshot. */
    subjectKind: text("subject_kind").notNull(),
    subjectRef: uuid("subject_ref").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("publication_versions_pub_version_unique").on(t.publicationId, t.versionNumber),
    check("publication_versions_version_positive_check", sql`${t.versionNumber} > 0`),
    check(
      "publication_versions_content_type_check",
      sql`${t.contentType} in ('film', 'series', 'episode', 'short', 'music', 'documentary', 'trailer')`,
    ),
    check(
      "publication_versions_subject_kind_check",
      sql`${t.subjectKind} in ('production', 'asset_version', 'ai_creator_profile', 'campaign_creative')`,
    ),
    index("idx_publication_versions_org_pub").on(t.orgId, t.publicationId),
  ],
).enableRLS();

/**
 * Immutable distribution attempt record — publication/distribution identity
 * per delivery attempt. No provider credentials, no worker data (D2.12-F:
 * operator-initiated synchronous delivery only in this stage). Runtime
 * grants: INSERT + SELECT only.
 */
export const distributionReferences = pgTable(
  "distribution_references",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    publicationId: uuid("publication_id")
      .notNull()
      .references((): AnyPgColumn => publications.id, { onDelete: "restrict" }),
    versionId: uuid("version_id")
      .notNull()
      .references((): AnyPgColumn => publicationVersions.id, { onDelete: "restrict" }),
    platformTarget: text("platform_target").notNull(),
    /** Opaque external identity from the platform adapter; no secrets. */
    externalRef: text("external_ref"),
    /** FROZEN delivery outcome enum: delivered | failed (never 'succeeded'). */
    deliveryOutcome: text("delivery_outcome").notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("distribution_references_delivery_outcome_check", sql`${t.deliveryOutcome} in ('delivered', 'failed')`),
    check(
      "distribution_references_platform_target_check",
      sql`${t.platformTarget} in ('stratifit-media', 'youtube', 'tiktok', 'instagram', 'facebook')`,
    ),
    index("idx_distribution_references_org_pub").on(t.orgId, t.publicationId),
  ],
).enableRLS();

export type PublicationRow = typeof publications.$inferSelect;
export type NewPublicationRow = typeof publications.$inferInsert;
export type PublicationVersionRow = typeof publicationVersions.$inferSelect;
export type NewPublicationVersionRow = typeof publicationVersions.$inferInsert;
export type DistributionReferenceRow = typeof distributionReferences.$inferSelect;
export type NewDistributionReferenceRow = typeof distributionReferences.$inferInsert;

/**
 * Public Media & Audience — context 12, aggregate 20 (Stage 2.13).
 *
 * Durable PUBLIC CONTENT projection. INVARIANT 10: public content must
 * originate from an approved publication — there is no second content
 * universe. Rows are created ONLY by the audience consumer of
 * `publication.published` (idempotent, keyed by publication_version_id) and
 * retired from public reads via the `publication.unpublished` consumer
 * (D2.13-1). The aggregate is mutable ONLY through the status flip
 * (published -> unpublished); version snapshots themselves are immutable, so
 * a correction creates a new publication version and a new projection.
 */
export const publicContent = pgTable(
  "public_content",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Authoritative same-database publishing references (D2.13-4). */
    publicationId: uuid("publication_id")
      .notNull()
      .references((): AnyPgColumn => publications.id, { onDelete: "restrict" }),
    /** Projection idempotency key — one version, one row, one slug, forever. */
    publicationVersionId: uuid("publication_version_id")
      .notNull()
      .references((): AnyPgColumn => publicationVersions.id, { onDelete: "restrict" }),
    /** Public URL address. GLOBALLY unique (D2.13-2); never contains internal IDs or org identity. */
    slug: text("slug").notNull(),
    /** DM section 20 public content taxonomy (broader than the publication enum, D2.13-3). */
    contentType: text("content_type").notNull(),
    title: text("title").notNull(),
    synopsis: text("synopsis"),
    /**
     * Public asset-version METADATA references only — ids and coarse
     * classification, never binary paths/URLs (binaries stay behind storage).
     * Enrichment from asset metadata is a deferred seam; defaults to {}.
     */
    mediaRefs: jsonb("media_refs").notNull().default({}),
    durationSeconds: integer("duration_seconds"),
    /** People (context 4) is not durable yet — reserved, never exposed. */
    creatorProfileRef: uuid("creator_profile_ref"),
    /** Series/episode navigation reserved (D2.13-3); series content is not creatable yet. */
    seriesRef: uuid("series_ref"),
    episodeNumber: integer("episode_number"),
    categories: jsonb("categories").notNull().default([]),
    /** Publish-time fact from the committed publication.published envelope. */
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    /** Public visibility: listContent/getContentBySlug filter on published. */
    status: text("status").notNull().default("published"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "public_content_content_type_check",
      sql`${t.contentType} in ('film', 'movie', 'series', 'episode', 'short', 'comedy', 'skit', 'music', 'music-video', 'documentary', 'live-program', 'trailer', 'advertisement')`,
    ),
    check("public_content_status_check", sql`${t.status} in ('published', 'unpublished')`),
    check(
      "public_content_duration_check",
      sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`,
    ),
    check(
      "public_content_episode_number_check",
      sql`${t.episodeNumber} is null or ${t.episodeNumber} >= 0`,
    ),
    unique("public_content_slug_unique").on(t.slug),
    unique("public_content_publication_version_unique").on(t.publicationVersionId),
    index("idx_public_content_org_status").on(t.orgId, t.status),
    index("idx_public_content_publication").on(t.publicationId),
  ],
).enableRLS();

export type PublicContentRow = typeof publicContent.$inferSelect;
export type NewPublicContentRow = typeof publicContent.$inferInsert;


/**
 * Public Media & Audience — context 12 (Stage 2.14).
 *
 * WATCH PROGRESS — transactional per (audience user, public content):
 * position seconds, updated at; powers "continue watching" (DM section 21,
 * DATA_FLOW flow 17). Audience-private owner state: rows are created/updated
 * ONLY through the audience module's owner-scoped command API — the userId
 * is server-derived from the authenticated audience session and the org is
 * the audience user's own org row; neither is ever client-supplied.
 * Anonymous viewers produce no rows (watching requires no user record).
 */
export const watchProgress = pgTable(
  "watch_progress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Identity-owned audience user (SVC ownership resolution); status-deactivated, never deleted (D2.14-1). */
    audienceUserId: uuid("audience_user_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    /** Opaque-to-audience public content reference (D2.13-4 FK precedent). */
    contentRef: uuid("content_ref")
      .notNull()
      .references((): AnyPgColumn => publicContent.id, { onDelete: "restrict" }),
    positionSeconds: integer("position_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("watch_progress_position_check", sql`${t.positionSeconds} >= 0`),
    /** DM section 21 upsert key: one progress row per (user, content). */
    unique("watch_progress_user_content_unique").on(t.audienceUserId, t.contentRef),
    index("idx_watch_progress_content").on(t.contentRef),
  ],
).enableRLS();

export type WatchProgressRow = typeof watchProgress.$inferSelect;
export type NewWatchProgressRow = typeof watchProgress.$inferInsert;

/**
 * Stage 2.18 — in-app NOTIFICATIONS (frozen D2.18-SELECT, D2.18-N1..N5).
 *
 * Audience-PRIVATE owner aggregate: one durable feed per audience user.
 * INVARIANT: rows are created ONLY by the `message.created` consumer (the
 * composition-root handler resolves the recipient from committed conversation
 * state, D2.18-N1 — the event payload stays frozen). `event_id` is the
 * durable idempotency key (envelope eventId); replay/duplicate delivery
 * cannot create a second row. Unread state is DERIVED (`read_at IS NULL`,
 * D2.18-N5) — never a denormalized counter. Kinds: `conversation_reply` only
 * (social kinds deferred per D2.18-N2 / D2.15-3; no notification.* events,
 * taxonomy stays at 36 per D2.18-N3).
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Owner. Every access path is keyed by this server-derived identity. */
    audienceUserId: uuid("audience_user_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    sourceKind: text("source_kind"),
    /** Owner-scoped opaque addressing reference (D2.13-4 FK precedent). */
    sourceRef: uuid("source_ref"),
    /** Durable idempotency key = envelope eventId (D2.18-P1). */
    eventId: text("event_id").notNull().unique(),
    title: text("title").notNull(),
    body: text("body"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("notifications_kind_check", sql`${t.kind} in ('conversation_reply')`),
    check("notifications_source_kind_check", sql`${t.sourceKind} is null or ${t.sourceKind} in ('conversation')`),
    /** Derived unread (D2.18-N5): index (owner, newest-first) serves feed + unread scan. */
    index("idx_notifications_owner_created").on(t.audienceUserId, t.createdAt.desc()),
  ],
).enableRLS();

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

/**
 * Stage 2.19 - ANALYTICS INTAKE (frozen D2.19-SELECT, D2.19-A1..A6).
 *
 * The platform's FIRST PUBLIC UNAUTHENTICATED WRITE SURFACE (beacon).
 * IMMUTABLE family (INSERT+SELECT only, live 42501 proofs): rows are
 * append-only accepted events; there is no update/delete/read path anywhere
 * (D2.19-A6: no read model in this stage). `ingest_event_id` is the
 * idempotency key and EQUALS the emitted `analytics.received` envelope
 * eventId (D2.19-A2 relationship) - replay is deduped at the UNIQUE and
 * never re-emits. `org_id`/`audience_user_id` are SERVER-RESOLVED only;
 * client authority fields are structurally rejected at the beacon. Raw
 * session ids and IPs are never persisted - only the SHA-256 session hash.
 * Retention (180 days) is DOCUMENTED-ONLY (D2.19-P7): no worker/deletion.
 */
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: text("event_type").notNull(),
    contentRef: uuid("content_ref").references((): AnyPgColumn => publicContent.id, { onDelete: "restrict" }),
    /** Server-resolved from the content row / audience user; never client-supplied. */
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "restrict" }),
    /** Server-derived audience principal; never a request-body field. */
    audienceUserId: uuid("audience_user_id").references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    /** SHA-256 hex of the client session id (64 chars); raw id never stored. */
    sessionHash: text("session_hash").notNull(),
    /** Flat allowlist properties (validated at intake; no nested/arrays). */
    properties: jsonb("properties"),
    clientTs: timestamp("client_ts", { withTimezone: true }),
    /** Ingestion provenance. */
    serverTs: timestamp("server_ts", { withTimezone: true }).notNull().defaultNow(),
    /** Idempotency key === analytics.received envelope eventId (D2.19-A2). */
    ingestEventId: text("ingest_event_id").notNull().unique(),
  },
  (t) => [
    check(
      "analytics_events_event_type_check",
      sql`${t.eventType} in ('content_view', 'content_progress', 'content_complete', 'content_share')`,
    ),
    check("analytics_events_session_hash_check", sql`char_length(${t.sessionHash}) = 64`),
    index("idx_analytics_content_ts").on(t.contentRef, t.serverTs.desc()),
    index("idx_analytics_type_ts").on(t.eventType, t.serverTs.desc()),
  ],
).enableRLS();

export type AnalyticsEventRow = typeof analyticsEvents.$inferSelect;
export type NewAnalyticsEventRow = typeof analyticsEvents.$inferInsert;

/**
 * Social Graph — context 13 (Stage 2.15, D2.15-1..6).
 *
 * LIKE — owner-scoped audience-platform state over PUBLISHED public content.
 * Hard-delete toggle semantics (D2.15-2): unlike removes the row; re-like
 * creates a fresh active relationship. UNIQUE(audience_user_id, content_ref)
 * makes the like command idempotent (duplicate = no-op). Rows reference
 * public content and audience identities only — never production internals.
 */
export const likes = pgTable(
  "likes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Owner — server-derived from the authenticated audience session. */
    audienceUserId: uuid("audience_user_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    /** Target — published public content only (service-enforced). */
    contentRef: uuid("content_ref")
      .notNull()
      .references((): AnyPgColumn => publicContent.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("likes_user_content_unique").on(t.audienceUserId, t.contentRef),
    index("idx_likes_content").on(t.contentRef),
    index("idx_likes_user").on(t.audienceUserId),
  ],
).enableRLS();

export type LikeRow = typeof likes.$inferSelect;
export type NewLikeRow = typeof likes.$inferInsert;

/**
 * Social Graph — context 13 (Stage 2.15).
 *
 * SAVE — bookmark with hard-delete toggle semantics (D2.15-2), identical
 * shape/lifecycle to Like. Owner-scoped; UNIQUE(audience_user_id,
 * content_ref) idempotency key.
 */
export const saves = pgTable(
  "saves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    audienceUserId: uuid("audience_user_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    contentRef: uuid("content_ref")
      .notNull()
      .references((): AnyPgColumn => publicContent.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("saves_user_content_unique").on(t.audienceUserId, t.contentRef),
    index("idx_saves_content").on(t.contentRef),
    index("idx_saves_user").on(t.audienceUserId),
  ],
).enableRLS();

export type SaveRow = typeof saves.$inferSelect;
export type NewSaveRow = typeof saves.$inferInsert;

/**
 * Social Graph — context 13 (Stage 2.15).
 *
 * FOLLOW — asymmetric directed relationship with TOMBSTONE semantics
 * (D2.15-2): unfollow sets deleted_at; re-follow reactivates the same row by
 * clearing deleted_at (the UNIQUE constraints are partial on deleted_at IS
 * NULL so a tombstoned row never blocks reactivation). Audience-user targets
 * are live; creator-profile targets are STRUCTURALLY supported (kind CHECK)
 * but FAIL CLOSED at the service until People is durable (D2.15-1) —
 * followee_creator_profile_ref deliberately has NO foreign key.
 */
export const followGraph = pgTable(
  "follow_graph",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Follower — server-derived from the authenticated audience session. */
    followerId: uuid("follower_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    followeeKind: text("followee_kind").notNull(),
    /** Populated iff followee_kind = 'audience_user'. */
    followeeAudienceUserId: uuid("followee_audience_user_id").references(
      (): AnyPgColumn => audienceUsers.id,
      { onDelete: "restrict" },
    ),
    /** Populated iff followee_kind = 'creator_profile'; no FK (People not durable). */
    followeeCreatorProfileRef: uuid("followee_creator_profile_ref"),
    /** TOMBSTONE (D2.15-2) — non-null means the relationship is inactive. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "follow_graph_followee_kind_check",
      sql`${t.followeeKind} in ('audience_user', 'creator_profile')`,
    ),
    check(
      "follow_graph_followee_target_check",
      sql`(${t.followeeKind} = 'audience_user' and ${t.followeeAudienceUserId} is not null and ${t.followeeCreatorProfileRef} is null)
          or (${t.followeeKind} = 'creator_profile' and ${t.followeeAudienceUserId} is null and ${t.followeeCreatorProfileRef} is not null)`,
    ),
    check(
      "follow_graph_no_self_follow_check",
      sql`${t.followeeKind} <> 'audience_user' or ${t.followeeAudienceUserId} <> ${t.followerId}`,
    ),
    uniqueIndex("follow_graph_audience_active_unique")
      .on(t.followerId, t.followeeAudienceUserId)
      .where(sql`${t.followeeKind} = 'audience_user' and ${t.deletedAt} is null`),
    uniqueIndex("follow_graph_creator_active_unique")
      .on(t.followerId, t.followeeCreatorProfileRef)
      .where(sql`${t.followeeKind} = 'creator_profile' and ${t.deletedAt} is null`),
    index("idx_follow_graph_followee").on(t.followeeKind, t.followeeAudienceUserId),
    index("idx_follow_graph_follower").on(t.followerId),
  ],
).enableRLS();

export type FollowGraphRow = typeof followGraph.$inferSelect;
export type NewFollowGraphRow = typeof followGraph.$inferInsert;

/**
 * Social Graph — context 13 (Stage 2.15).
 *
 * COMMENT — email-verified authorship over published public content with
 * two-level threading (parent self-FK). Visibility states per D2.15-4:
 * visible | hidden | removed. The PUBLIC query exposes only 'visible' rows;
 * moderation transitions are a reserved seam (no Control UI in this stage).
 * There is no hard DELETE path — 'removed' is the safe deletion state and is
 * terminal, so parent rows always exist for their replies (parent FK is
 * RESTRICT).
 */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Author — email verification is enforced at write time by the service. */
    authorId: uuid("author_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    contentRef: uuid("content_ref")
      .notNull()
      .references((): AnyPgColumn => publicContent.id, { onDelete: "restrict" }),
    /** Two-level threading — replies only under VISIBLE parents (service rule). */
    parentCommentId: uuid("parent_comment_id").references((): AnyPgColumn => comments.id, {
      onDelete: "restrict",
    }),
    body: text("body").notNull(),
    /** D2.15-4: visible | hidden | removed; public reads filter to visible. */
    visibility: text("visibility").notNull().default("visible"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("comments_visibility_check", sql`${t.visibility} in ('visible', 'hidden', 'removed')`),
    check("comments_body_length_check", sql`char_length(${t.body}) between 1 and 2000`),
    index("idx_comments_content_visibility").on(t.contentRef, t.visibility),
    index("idx_comments_author").on(t.authorId),
    index("idx_comments_parent").on(t.parentCommentId),
  ],
).enableRLS();

export type CommentRow = typeof comments.$inferSelect;
export type NewCommentRow = typeof comments.$inferInsert;

/**
 * Social Graph — context 13 (Stage 2.15).
 *
 * SHARE — IMMUTABLE fact semantics (D2.15-6): each share records (owner,
 * content, channel) at a point in time. Duplicates are distinct facts — no
 * uniqueness, no update path exists anywhere in the service. Channel is the
 * narrow CHECK enum copy_link | external; no free-form strings.
 */
export const shares = pgTable(
  "shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    audienceUserId: uuid("audience_user_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    contentRef: uuid("content_ref")
      .notNull()
      .references((): AnyPgColumn => publicContent.id, { onDelete: "restrict" }),
    channel: text("channel").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("shares_channel_check", sql`${t.channel} in ('copy_link', 'external')`),
    index("idx_shares_user").on(t.audienceUserId),
    index("idx_shares_content").on(t.contentRef),
  ],
).enableRLS();

export type ShareRow = typeof shares.$inferSelect;
export type NewShareRow = typeof shares.$inferInsert;

/**
 * People (Digital Humans) — context 4 (Stage 2.16, D2.16-1..8).
 *
 * The DM section 10 chain: Digital Human → Character → Persona → AI Creator
 * → Public Profile. FIVE DISTINCT entities; none implies the next
 * (invariant 11). Chain-only foundation per D2.16-1 — voices/wardrobes are
 * deferred. Every aggregate is org-scoped; chain FKs are intra-People
 * RESTRICT; cross-context refs (base model/workflow versions) stay LOOSE by
 * design (no cross-context foreign keys, house rule).
 *
 * DIGITAL HUMAN — the underlying synthetic person (appearance/identity core).
 * Mutable Control-authored aggregate; lifecycle draft→active→retired.
 */
export const digitalHumans = pgTable(
  "digital_humans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** Opaque asset-version appearance refs — metadata only, never binaries. */
    appearanceRefs: jsonb("appearance_refs").$type<string[]>().notNull().default([]),
    /** Loose catalog version refs (versions are immutable; no cross-context FK). */
    baseModelVersionRef: uuid("base_model_version_ref"),
    baseWorkflowVersionRef: uuid("base_workflow_version_ref"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("digital_humans_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    index("idx_digital_humans_org_status").on(t.orgId, t.status),
  ],
).enableRLS();

export type DigitalHumanRow = typeof digitalHumans.$inferSelect;
export type NewDigitalHumanRow = typeof digitalHumans.$inferInsert;

/**
 * People (Stage 2.16).
 *
 * CHARACTER — a role/identity a digital human portrays. digitalHumanId is
 * NULLABLE (characters can exist uncast, DM section 10). Mutable;
 * draft→active→retired.
 */
export const characters = pgTable(
  "characters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    digitalHumanId: uuid("digital_human_id").references((): AnyPgColumn => digitalHumans.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    bio: text("bio"),
    visualRefs: jsonb("visual_refs").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("characters_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    index("idx_characters_org_status").on(t.orgId, t.status),
    index("idx_characters_digital_human").on(t.digitalHumanId),
  ],
).enableRLS();

export type CharacterRow = typeof characters.$inferSelect;
export type NewCharacterRow = typeof characters.$inferInsert;

/**
 * People (Stage 2.16).
 *
 * PERSONA — the personality/behavior layer ABOVE a character. The chain
 * requires the character to exist (NOT NULL FK). Mutable;
 * draft→active→retired.
 */
export const personas = pgTable(
  "personas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    characterId: uuid("character_id")
      .notNull()
      .references((): AnyPgColumn => characters.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    personality: text("personality"),
    interests: jsonb("interests").$type<string[]>().notNull().default([]),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    languages: jsonb("languages").$type<string[]>().notNull().default([]),
    behaviorConfig: jsonb("behavior_config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("personas_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    index("idx_personas_org_status").on(t.orgId, t.status),
    index("idx_personas_character").on(t.characterId),
  ],
).enableRLS();

export type PersonaRow = typeof personas.$inferSelect;
export type NewPersonaRow = typeof personas.$inferInsert;

/**
 * People (Stage 2.16).
 *
 * AI CREATOR — the operational entertainer entity the Control Room operates:
 * a persona packaged with production/communication capability. Mutable;
 * draft→active⇄paused→retired. Handle is unique per org. `isAi` is the
 * always-true disclosure flag (DM section 10).
 */
export const aiCreators = pgTable(
  "ai_creators",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    personaId: uuid("persona_id")
      .notNull()
      .references((): AnyPgColumn => personas.id, { onDelete: "restrict" }),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    contentCategories: jsonb("content_categories").$type<string[]>().notNull().default([]),
    communicationConfig: jsonb("communication_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Always-true AI disclosure (DM section 10); CHECK-enforced below. */
    isAi: boolean("is_ai").notNull().default(true),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ai_creators_status_check", sql`${t.status} in ('draft', 'active', 'paused', 'retired')`),
    check("ai_creators_handle_shape_check", sql`${t.handle} ~ '^[a-z0-9-]{3,64}$'`),
    check("ai_creators_is_ai_check", sql`${t.isAi} = true`),
    unique("ai_creators_org_handle_unique").on(t.orgId, t.handle),
    index("idx_ai_creators_org_status").on(t.orgId, t.status),
    index("idx_ai_creators_persona").on(t.personaId),
  ],
).enableRLS();

export type AiCreatorRow = typeof aiCreators.$inferSelect;
export type NewAiCreatorRow = typeof aiCreators.$inferInsert;

/**
 * People (Stage 2.16).
 *
 * PUBLIC PROFILE — the PUBLICATION-FACING identity of an AI creator.
 * CRITICAL (D2.16-3): snapshot rows are authored ONLY through the
 * publication flow (publishing → people mediated API, same-transaction
 * discipline per consumer) — there is NO arbitrary profile edit path.
 * Snapshots form an append-only family keyed by publication_version_id
 * (idempotency + provenance); a republish retires the previous current row
 * to 'unpublished' and activates the new one; historical rows persist.
 * Status has no 'draft' — a profile exists only after a real publication.
 */
export const creatorProfiles = pgTable(
  "creator_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    aiCreatorId: uuid("ai_creator_id")
      .notNull()
      .references((): AnyPgColumn => aiCreators.id, { onDelete: "restrict" }),
    /** Provenance: the publication family that authored this snapshot. */
    publicationId: uuid("publication_id")
      .notNull()
      .references((): AnyPgColumn => publications.id, { onDelete: "restrict" }),
    /** Snapshot source version — the IDEMPOTENCY key (one snapshot per version). */
    publicationVersionId: uuid("publication_version_id")
      .notNull()
      .references((): AnyPgColumn => publicationVersions.id, { onDelete: "restrict" }),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    personalitySnapshot: jsonb("personality_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    interestsSnapshot: jsonb("interests_snapshot").$type<string[]>().notNull().default([]),
    /** Opaque asset-version refs — never storage paths/URLs. */
    avatarRef: uuid("avatar_ref"),
    posterRef: uuid("poster_ref"),
    /** True only if the AI creator's communication config allows messaging. */
    messagingEnabled: boolean("messaging_enabled").notNull().default(false),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("creator_profiles_status_check", sql`${t.status} in ('active', 'paused', 'unpublished')`),
    check("creator_profiles_handle_shape_check", sql`${t.handle} ~ '^[a-z0-9-]{3,64}$'`),
    /**
     * One CURRENT profile per (org, creator) and per (org, handle) — partial
     * uniques over the live statuses only. Historical snapshots (status =
     * 'unpublished') are RETAINED (D2.16-3: never hard-deleted) and must not
     * hold the slot that the next publication's snapshot row needs.
     */
    uniqueIndex("creator_profiles_org_creator_unique")
      .on(t.orgId, t.aiCreatorId)
      .where(sql`status <> 'unpublished'`),
    uniqueIndex("creator_profiles_org_handle_unique")
      .on(t.orgId, t.handle)
      .where(sql`status <> 'unpublished'`),
    /** Snapshot-family idempotency: one profile row per publication version, ever. */
    unique("creator_profiles_publication_version_unique").on(t.publicationVersionId),
    index("idx_creator_profiles_org_status").on(t.orgId, t.status),
    index("idx_creator_profiles_ai_creator").on(t.aiCreatorId),
  ],
).enableRLS();

export type CreatorProfileRow = typeof creatorProfiles.$inferSelect;
export type NewCreatorProfileRow = typeof creatorProfiles.$inferInsert;

// ===========================================================================
// MESSAGING & LEADS (Stage 2.17, D2.17-1..D2.17-11; bounded context 14, DM
// sections 23-24). conversations is the mutable aggregate (status machine,
// denormalized unread counters D2.17-7, per-participant last-read receipts
// D2.17-8); messages and lead_follow_ups are IMMUTABLE families (DM section
// 32.8: no lifecycle once written) — INSERT+SELECT only, live 42501 proofs.
// org_id is ALWAYS the creator profile's organization (server-derived from
// the handle resolution — never a client field).
// ===========================================================================

/** Conversation status machine (DM section 32.7) — enforced service-side; this CHECK mirrors it. */
export const CONVERSATION_STATUSES = ["open", "awaiting_ai", "active", "awaiting_human", "closed"] as const;

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    creatorProfileId: uuid("creator_profile_id")
      .notNull()
      .references((): AnyPgColumn => creatorProfiles.id, { onDelete: "restrict" }),
    audienceUserId: uuid("audience_user_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    subject: text("subject"),
    status: text("status").notNull().default("open"),
    /** Denormalized unread counters (D2.17-7): reset-to-zero on receipt, never decremented. */
    audienceUnreadCount: integer("audience_unread_count").notNull().default(0),
    creatorUnreadCount: integer("creator_unread_count").notNull().default(0),
    /** Per-participant read receipts (D2.17-8): mutable columns on the MUTABLE aggregate — never on messages. */
    audienceLastReadMessageId: uuid("audience_last_read_message_id").references((): AnyPgColumn => messages.id, { onDelete: "restrict" }),
    creatorLastReadMessageId: uuid("creator_last_read_message_id").references((): AnyPgColumn => messages.id, { onDelete: "restrict" }),
    /** One lead per conversation (service-enforced); nullable until a lead is created. */
    leadId: uuid("lead_id"),
    /** Human takeover record (DM section 23: assignment + audit fact, never a third participant row). */
    assignedOperatorId: uuid("assigned_operator_id"),
    takenOverAt: timestamp("taken_over_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("conversations_status_check", sql`${t.status} in ('open', 'awaiting_ai', 'active', 'awaiting_human', 'closed')`),
    check("conversations_subject_length_check", sql`${t.subject} is null or char_length(${t.subject}) between 1 and 200`),
    check("conversations_audience_unread_check", sql`${t.audienceUnreadCount} >= 0`),
    check("conversations_creator_unread_check", sql`${t.creatorUnreadCount} >= 0`),
    /**
     * At most ONE non-closed conversation per audience-user + creator-profile
     * pair (partial unique — Stage 2.16 precedent). Closed conversations are
     * history; a viewer may start a fresh conversation afterwards.
     */
    uniqueIndex("conversations_open_pair_unique")
      .on(t.audienceUserId, t.creatorProfileId)
      .where(sql`status <> 'closed'`),
    index("idx_conversations_org_status").on(t.orgId, t.status),
    index("idx_conversations_creator_profile").on(t.creatorProfileId),
    index("idx_conversations_audience_user").on(t.audienceUserId),
  ],
).enableRLS();

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;

/**
 * IMMUTABLE message family (DM section 32.8: "no lifecycle — immutable once
 * written"). Author consistency is enforced by CHECK: exactly one author ref
 * per kind; audience/operator send human messages (service-derived — clients
 * can never submit ai/system), ai/system are reserved for the future
 * Communication Engine (D2.17-2).
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversations.id, { onDelete: "restrict" }),
    authorKind: text("author_kind").notNull(),
    authorAudienceUserId: uuid("author_audience_user_id"),
    authorOperatorId: uuid("author_operator_id"),
    authorAiCreatorId: uuid("author_ai_creator_id"),
    messageType: text("message_type").notNull().default("message"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("messages_author_kind_check", sql`${t.authorKind} in ('ai', 'human', 'system')`),
    check("messages_message_type_check", sql`${t.messageType} in ('message', 'service_inquiry', 'system_notice')`),
    check("messages_body_length_check", sql`char_length(${t.body}) between 1 and 4000`),
    check(
      "messages_author_consistency_check",
      sql`(
        (author_kind = 'human' and ((author_audience_user_id is not null)::int + (author_operator_id is not null)::int = 1) and author_ai_creator_id is null)
        or (author_kind = 'ai' and author_ai_creator_id is not null and author_audience_user_id is null and author_operator_id is null)
        or (author_kind = 'system' and author_audience_user_id is null and author_operator_id is null and author_ai_creator_id is null)
      )`,
    ),
    index("idx_messages_conversation_created").on(t.conversationId, t.createdAt),
    index("idx_messages_org").on(t.orgId),
  ],
).enableRLS();

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

/** Creator service offering (DM section 24) — referenced by inquiries/leads. Table name is service_offerings: public.services is occupied by a pre-existing foreign marketing/CRM application on the shared Supabase project (see DOMAIN_MODEL section 38 note). */
export const serviceOfferings = pgTable(
  "service_offerings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    aiCreatorId: uuid("ai_creator_id")
      .notNull()
      .references((): AnyPgColumn => aiCreators.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("service_offerings_status_check", sql`${t.status} in ('active', 'retired')`),
    check("service_offerings_name_length_check", sql`char_length(${t.name}) between 1 and 200`),
    check("service_offerings_category_length_check", sql`${t.category} is null or char_length(${t.category}) between 1 and 100`),
    check("service_offerings_description_length_check", sql`${t.description} is null or char_length(${t.description}) <= 2000`),
    unique("service_offerings_org_creator_name_unique").on(t.orgId, t.aiCreatorId, t.name),
    index("idx_service_offerings_org_status").on(t.orgId, t.status),
    index("idx_service_offerings_ai_creator").on(t.aiCreatorId),
  ],
).enableRLS();

export type ServiceOfferingRow = typeof serviceOfferings.$inferSelect;
export type NewServiceOfferingRow = typeof serviceOfferings.$inferInsert;

/** A message classified as a business inquiry (DM section 24) — the seed of a Lead. */
export const serviceInquiries = pgTable(
  "service_inquiries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversations.id, { onDelete: "restrict" }),
    /** The classified message — one inquiry per message, ever. */
    messageId: uuid("message_id")
      .notNull()
      .references((): AnyPgColumn => messages.id, { onDelete: "restrict" }),
    classification: text("classification").notNull(),
    /** AI-derived confidence; always null in 2.17 (operator classification). */
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    requestedServiceId: uuid("requested_service_id").references((): AnyPgColumn => serviceOfferings.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("service_inquiries_status_check", sql`${t.status} in ('open', 'converted', 'dismissed')`),
    check("service_inquiries_classification_length_check", sql`char_length(${t.classification}) between 1 and 200`),
    check("service_inquiries_confidence_check", sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`),
    unique("service_inquiries_message_unique").on(t.messageId),
    index("idx_service_inquiries_conversation").on(t.conversationId),
    index("idx_service_inquiries_org_status").on(t.orgId, t.status),
  ],
).enableRLS();

export type ServiceInquiryRow = typeof serviceInquiries.$inferSelect;
export type NewServiceInquiryRow = typeof serviceInquiries.$inferInsert;

/** Lead pipeline (DM section 24, machine section 32.9) — transitions audited, never silent. */
export const LEAD_STATUSES = ["new", "triaged", "assigned", "in_progress", "won", "lost", "archived"] as const;

export const serviceLeads = pgTable(
  "service_leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversations.id, { onDelete: "restrict" }),
    creatorProfileId: uuid("creator_profile_id")
      .notNull()
      .references((): AnyPgColumn => creatorProfiles.id, { onDelete: "restrict" }),
    audienceUserId: uuid("audience_user_id")
      .notNull()
      .references((): AnyPgColumn => audienceUsers.id, { onDelete: "restrict" }),
    serviceInquiryId: uuid("service_inquiry_id")
      .notNull()
      .references((): AnyPgColumn => serviceInquiries.id, { onDelete: "restrict" }),
    classification: text("classification"),
    requestedServiceId: uuid("requested_service_id").references((): AnyPgColumn => serviceOfferings.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("new"),
    assignedOperatorId: uuid("assigned_operator_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("service_leads_status_check", sql`${t.status} in ('new', 'triaged', 'assigned', 'in_progress', 'won', 'lost', 'archived')`),
    check("service_leads_classification_length_check", sql`${t.classification} is null or char_length(${t.classification}) between 1 and 200`),
    index("idx_service_leads_org_status").on(t.orgId, t.status),
    index("idx_service_leads_conversation").on(t.conversationId),
    index("idx_service_leads_assigned_operator").on(t.assignedOperatorId),
  ],
).enableRLS();

export type ServiceLeadRow = typeof serviceLeads.$inferSelect;
export type NewServiceLeadRow = typeof serviceLeads.$inferInsert;

/**
 * IMMUTABLE follow-up records (DM section 24: "immutable: who, when, what").
 * INSERT+SELECT only — lead progress lives on the lead's own status machine.
 */
export const leadFollowUps = pgTable(
  "lead_follow_ups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    leadId: uuid("lead_id")
      .notNull()
      .references((): AnyPgColumn => serviceLeads.id, { onDelete: "restrict" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references((): AnyPgColumn => operators.id, { onDelete: "restrict" }),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("lead_follow_ups_note_length_check", sql`char_length(${t.note}) between 1 and 2000`),
    index("idx_lead_follow_ups_lead").on(t.leadId),
    index("idx_lead_follow_ups_org").on(t.orgId),
  ],
).enableRLS();

export type LeadFollowUpRow = typeof leadFollowUps.$inferSelect;
export type NewLeadFollowUpRow = typeof leadFollowUps.$inferInsert;

/**
 * Creative / Story (Stage 2.20, D2.20-1..D2.20-9).
 *
 * Seven-level narrative hierarchy (DM section 8, bounded context 3):
 *
 *   universes → worlds → stories → seasons → episodes → scenes → shots
 *
 * HARD BOUNDARIES (frozen):
 *  - D2.20-2: world-building catalog (locations/props/fictional orgs/vehicles/
 *    rules/timelines) DEFERRED — worlds are structural hierarchy nodes only.
 *  - D2.20-3: scripts DEFERRED — no script text storage (DM Open Question 8
 *    remains open); stories carry a numeric version only.
 *  - D2.20-4: NO creative.* events — taxonomy stays at 36.
 *  - D2.20-7: Control-only context — no Media surface, no publishing
 *    mediation; `campaign_creative` remains fail-closed.
 *
 * Conventions: org-scoped (org_id FK RESTRICT), server-side parent-chain
 * integrity at the service layer (same-org, non-retired parents — People
 * precedent), lifecycle CHECKs, mutable ARWD family granted in 0042.
 */
export const CREATIVE_STORY_KINDS = ["film", "series", "short", "campaign_narrative"] as const;

export const universes = pgTable(
  "universes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("universes_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    check("universes_name_length_check", sql`char_length(${t.name}) between 1 and 200`),
    check("universes_slug_shape_check", sql`${t.slug} ~ '^[a-z0-9-]{3,64}$'`),
    unique("universes_org_slug_unique").on(t.orgId, t.slug),
    index("idx_universes_org_status").on(t.orgId, t.status),
  ],
).enableRLS();

export type UniverseRow = typeof universes.$inferSelect;
export type NewUniverseRow = typeof universes.$inferInsert;

export const worlds = pgTable(
  "worlds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    universeId: uuid("universe_id")
      .notNull()
      .references((): AnyPgColumn => universes.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("worlds_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    check("worlds_name_length_check", sql`char_length(${t.name}) between 1 and 200`),
    index("idx_worlds_org_status").on(t.orgId, t.status),
    index("idx_worlds_universe").on(t.universeId),
  ],
).enableRLS();

export type WorldRow = typeof worlds.$inferSelect;
export type NewWorldRow = typeof worlds.$inferInsert;

export const stories = pgTable(
  "stories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    worldId: uuid("world_id").references((): AnyPgColumn => worlds.id, { onDelete: "restrict" }),
    universeId: uuid("universe_id")
      .references((): AnyPgColumn => universes.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    logline: text("logline").notNull(),
    kind: text("kind").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("stories_status_check", sql`${t.status} in ('draft', 'active', 'completed', 'retired')`),
    check("stories_kind_check", sql`${t.kind} in ('film', 'series', 'short', 'campaign_narrative')`),
    check("stories_title_length_check", sql`char_length(${t.title}) between 1 and 300`),
    check("stories_logline_length_check", sql`char_length(${t.logline}) between 1 and 1000`),
    check("stories_version_positive_check", sql`${t.version} >= 1`),
    index("idx_stories_org_status").on(t.orgId, t.status),
    index("idx_stories_world").on(t.worldId),
    index("idx_stories_universe").on(t.universeId),
  ],
).enableRLS();

export type StoryRow = typeof stories.$inferSelect;
export type NewStoryRow = typeof stories.$inferInsert;

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    storyId: uuid("story_id")
      .notNull()
      .references((): AnyPgColumn => stories.id, { onDelete: "restrict" }),
    seasonNumber: integer("season_number").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("seasons_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    check("seasons_title_length_check", sql`char_length(${t.title}) between 1 and 300`),
    check("seasons_number_positive_check", sql`${t.seasonNumber} >= 1`),
    unique("seasons_story_number_unique").on(t.storyId, t.seasonNumber),
    index("idx_seasons_org_status").on(t.orgId, t.status),
    index("idx_seasons_story").on(t.storyId),
  ],
).enableRLS();

export type SeasonRow = typeof seasons.$inferSelect;
export type NewSeasonRow = typeof seasons.$inferInsert;

export const episodes = pgTable(
  "episodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    seasonId: uuid("season_id").references((): AnyPgColumn => seasons.id, { onDelete: "restrict" }),
    storyId: uuid("story_id").references((): AnyPgColumn => stories.id, { onDelete: "restrict" }),
    /** D2.20: nullable settable-at-creation only; NOT updatable via Stage 2.20 commands. */
    productionId: uuid("production_id").references((): AnyPgColumn => productions.id, {
      onDelete: "restrict",
    }),
    episodeNumber: integer("episode_number").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("episodes_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    check("episodes_title_length_check", sql`char_length(${t.title}) between 1 and 300`),
    check("episodes_number_positive_check", sql`${t.episodeNumber} >= 1`),
    uniqueIndex("episodes_season_number_unique")
      .on(t.seasonId, t.episodeNumber)
      .where(sql`season_id is not null`),
    index("idx_episodes_org_status").on(t.orgId, t.status),
    index("idx_episodes_season").on(t.seasonId),
    index("idx_episodes_story").on(t.storyId),
  ],
).enableRLS();

export type EpisodeRow = typeof episodes.$inferSelect;
export type NewEpisodeRow = typeof episodes.$inferInsert;

export const scenes = pgTable(
  "scenes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    storyId: uuid("story_id").references((): AnyPgColumn => stories.id, { onDelete: "restrict" }),
    episodeId: uuid("episode_id")
      .references((): AnyPgColumn => episodes.id, { onDelete: "restrict" }),
    /** D2.20: nullable settable-at-creation only; NOT updatable via Stage 2.20 commands. */
    productionId: uuid("production_id").references((): AnyPgColumn => productions.id, {
      onDelete: "restrict",
    }),
    orderIndex: integer("order_index").notNull(),
    title: text("title").notNull(),
    synopsis: text("synopsis"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("scenes_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    check("scenes_title_length_check", sql`char_length(${t.title}) between 1 and 300`),
    check("scenes_order_nonnegative_check", sql`${t.orderIndex} >= 0`),
    uniqueIndex("scenes_episode_order_unique")
      .on(t.episodeId, t.orderIndex)
      .where(sql`episode_id is not null`),
    uniqueIndex("scenes_story_order_unique")
      .on(t.storyId, t.orderIndex)
      .where(sql`story_id is not null and episode_id is null`),
    index("idx_scenes_org_status").on(t.orgId, t.status),
    index("idx_scenes_story").on(t.storyId),
    index("idx_scenes_episode").on(t.episodeId),
  ],
).enableRLS();

export type SceneRow = typeof scenes.$inferSelect;
export type NewSceneRow = typeof scenes.$inferInsert;

export const shots = pgTable(
  "shots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sceneId: uuid("scene_id")
      .notNull()
      .references((): AnyPgColumn => scenes.id, { onDelete: "restrict" }),
    orderIndex: integer("order_index").notNull(),
    description: text("description").notNull(),
    aspect: text("aspect").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    fps: integer("fps").notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("shots_status_check", sql`${t.status} in ('draft', 'active', 'retired')`),
    check("shots_description_length_check", sql`char_length(${t.description}) between 1 and 2000`),
    check("shots_order_nonnegative_check", sql`${t.orderIndex} >= 0`),
    check("shots_aspect_shape_check", sql`char_length(${t.aspect}) between 1 and 20`),
    check("shots_duration_positive_check", sql`${t.durationSeconds} > 0`),
    check("shots_fps_range_check", sql`${t.fps} between 1 and 240`),
    unique("shots_scene_order_unique").on(t.sceneId, t.orderIndex),
    index("idx_shots_org_status").on(t.orgId, t.status),
    index("idx_shots_scene").on(t.sceneId),
  ],
).enableRLS();

export type ShotRow = typeof shots.$inferSelect;
export type NewShotRow = typeof shots.$inferInsert;

/**
 * Rights & Consent (Stage 2.21, D2.21-1..D2.21-8).
 *
 * Three-table family (DM section 11, bounded context 5):
 *
 *   rights_owners → rights_grants → rights_status_events (immutable history)
 *
 * HARD BOUNDARIES (frozen):
 *  - D2.21-1: v1 subject kinds are EXACTLY digital_human|character|persona|
 *    asset|production — `voice` is EXCLUDED pending DM Open Question 1.
 *  - D2.21-2: the Publishing/People rights ports remain UNWIRED — this stage
 *    is additive-only (adapters + evaluation seam built, zero behavior change
 *    in Production gates / Publishing approval / People authoring / QC).
 *  - D2.21-3: NO rights.* events — rights_status_events is the history of
 *    record (IMMUTABLE INSERT+SELECT family); taxonomy stays 36.
 *  - D2.21-5: grant lifecycle draft → active → (suspended ⇄ active) →
 *    revoked|expired; revoked/expired terminal; evaluation is LAZY (time
 *    windows evaluated at use time) — no worker-driven expiry.
 *  - D2.21-6: grant CORE fields are immutable through the service API —
 *    only status transitions mutate rows; grants are never deleted.
 *
 * Conventions: org-scoped (org_id FK RESTRICT), in-transaction subject/owner
 * integrity at the service layer (same-org, fail-closed not_found — People/
 * Creative precedent), mutable ARWD family for owners/grants in 0044.
 */
export const RIGHTS_SUBJECT_KINDS = ["digital_human", "character", "persona", "asset", "production"] as const;
export const RIGHTS_SCOPES = ["generation", "publication", "advertising", "messaging", "derivative_creation"] as const;
export const RIGHTS_PLATFORMS = ["stratifit_media", "youtube", "tiktok", "instagram", "facebook", "all"] as const;

export const rightsOwners = pgTable(
  "rights_owners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    contactRef: text("contact_ref"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("rights_owners_kind_check", sql`${t.kind} in ('individual', 'organization')`),
    check(
      "rights_owners_verification_check",
      sql`${t.verificationStatus} in ('unverified', 'pending', 'verified', 'rejected')`,
    ),
    check("rights_owners_name_length_check", sql`char_length(${t.displayName}) between 1 and 200`),
    index("idx_rights_owners_org").on(t.orgId, t.verificationStatus),
  ],
).enableRLS();

export type RightsOwnerRow = typeof rightsOwners.$inferSelect;
export type NewRightsOwnerRow = typeof rightsOwners.$inferInsert;

export const rightsGrants = pgTable(
  "rights_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references((): AnyPgColumn => rightsOwners.id, { onDelete: "restrict" }),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    scope: text("scope").notNull(),
    platforms: text("platforms").array().notNull(),
    territories: text("territories").array().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("draft"),
    grantedBy: uuid("granted_by").notNull(),
    evidenceRefs: text("evidence_refs").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "rights_grants_subject_kind_check",
      sql`${t.subjectKind} in ('digital_human', 'character', 'persona', 'asset', 'production')`,
    ),
    check(
      "rights_grants_scope_check",
      sql`${t.scope} in ('generation', 'publication', 'advertising', 'messaging', 'derivative_creation')`,
    ),
    check(
      "rights_grants_status_check",
      sql`${t.status} in ('draft', 'active', 'expired', 'revoked', 'suspended')`,
    ),
    check(
      "rights_grants_platforms_check",
      sql`${t.platforms} <@ array['stratifit_media', 'youtube', 'tiktok', 'instagram', 'facebook', 'all']::text[] and cardinality(${t.platforms}) between 1 and 6`,
    ),
    check("rights_grants_territories_check", sql`cardinality(${t.territories}) between 1 and 50`),
    check(
      "rights_grants_validity_window_check",
      sql`${t.expiresAt} is null or ${t.startsAt} is null or ${t.expiresAt} > ${t.startsAt}`,
    ),
    index("idx_rights_grants_subject").on(t.orgId, t.subjectKind, t.subjectId, t.scope),
    index("idx_rights_grants_owner").on(t.ownerId),
  ],
).enableRLS();

export type RightsGrantRow = typeof rightsGrants.$inferSelect;
export type NewRightsGrantRow = typeof rightsGrants.$inferInsert;

export const rightsStatusEvents = pgTable(
  "rights_status_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    grantId: uuid("grant_id")
      .notNull()
      .references((): AnyPgColumn => rightsGrants.id, { onDelete: "restrict" }),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    reason: text("reason"),
    actorId: uuid("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "rights_status_events_status_check",
      sql`${t.fromStatus} in ('draft', 'active', 'expired', 'revoked', 'suspended') and ${t.toStatus} in ('draft', 'active', 'expired', 'revoked', 'suspended')`,
    ),
    index("idx_rights_status_events_grant").on(t.grantId, t.createdAt),
    index("idx_rights_status_events_org").on(t.orgId),
  ],
).enableRLS();

export type RightsStatusEventRow = typeof rightsStatusEvents.$inferSelect;
export type NewRightsStatusEventRow = typeof rightsStatusEvents.$inferInsert;

/**
 * Rights requirements declarations (Stage 2.22, D2.22-1).
 *
 * Declares WHAT usage a subject requires before the Rights evaluator treats
 * rights as relevant: without a declaration row the subject is `declared:
 * false` (vacuous pass — D2.22-2, preserving Stage 2.12/2.16 semantics
 * EXACTLY). UNIQUE(org, subject_kind, subject_id, scope). `enforce` rows are
 * IMMUTABLE after creation (D2.22-3: retire by replacement, never edit core
 * semantics); `record_only` rows may be corrected. This is the declaration
 * model that makes a future port cutover principled (Stage 2.23); nothing
 * consumes it in Stage 2.22.
 */
export const rightsRequirements = pgTable(
  "rights_requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    scope: text("scope").notNull(),
    platforms: text("platforms").array().notNull(),
    territories: text("territories").array().notNull(),
    enforcement: text("enforcement").notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("rights_requirements_subject_scope_unique").on(t.orgId, t.subjectKind, t.subjectId, t.scope),
    check(
      "rights_requirements_subject_kind_check",
      sql`${t.subjectKind} in ('digital_human', 'character', 'persona', 'asset', 'production')`,
    ),
    check(
      "rights_requirements_scope_check",
      sql`${t.scope} in ('generation', 'publication', 'advertising', 'messaging', 'derivative_creation')`,
    ),
    check(
      "rights_requirements_enforcement_check",
      sql`${t.enforcement} in ('enforce', 'record_only')`,
    ),
    check(
      "rights_requirements_platforms_check",
      sql`${t.platforms} <@ array['stratifit_media','youtube','tiktok','instagram','facebook','all']::text[] and array_length(${t.platforms}, 1) >= 1`,
    ),
    check(
      "rights_requirements_reason_len_check",
      sql`${t.reason} is null or length(${t.reason}) <= 1000`,
    ),
    index("idx_rights_requirements_subject").on(t.orgId, t.subjectKind, t.subjectId),
    index("idx_rights_requirements_org").on(t.orgId),
  ],
).enableRLS();

export type RightsRequirementRow = typeof rightsRequirements.$inferSelect;
export type NewRightsRequirementRow = typeof rightsRequirements.$inferInsert;
