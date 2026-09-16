import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * FOUNDATIONAL SCHEMA ONLY.
 *
 * Per the approved foundation plan, the domain model (productions, scenes,
 * shots, assets, generations, publications, AI creators, conversations,
 * messages, audit logs) is deliberately NOT defined here. Domain tables are
 * introduced in later migrations after DOMAIN_MODEL.md is approved. This
 * schema stays minimal and domain-neutral so later migrations extend it
 * cleanly.
 */

/**
 * Domain-neutral platform configuration store. Proves the migration
 * infrastructure end-to-end; may be dropped later if unneeded.
 */
export const platformConfig = pgTable("platform_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PlatformConfigRow = typeof platformConfig.$inferSelect;
export type NewPlatformConfigRow = typeof platformConfig.$inferInsert;
