import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
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
    check("organizations_status_check", sql`${t.status} in ('active', 'suspended')`),
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
export type PlatformConfigRow = typeof platformConfig.$inferSelect;
export type NewPlatformConfigRow = typeof platformConfig.$inferInsert;
