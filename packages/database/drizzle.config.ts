import { defineConfig } from "drizzle-kit";

/**
 * Migration generation runs OFFLINE (no database connection required):
 *   pnpm --filter @stratifit/database db:generate
 *
 * Migrations (`drizzle-kit migrate`) connect as the dedicated migration/
 * schema-owner role via DATABASE_MIGRATE_URL (Stage 2.2 decision R1 — the
 * two-role split). The runtime application role in DATABASE_URL must NEVER
 * be used for migrations: it has no DDL privileges by design.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_MIGRATE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://localhost:5432/stratifit",
  },
});
