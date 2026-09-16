import { defineConfig } from "drizzle-kit";

/**
 * Migration generation runs OFFLINE (no database connection required):
 *   pnpm --filter @stratifit/database db:generate
 *
 * DATABASE_URL is only needed at runtime, not for generating migrations.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/stratifit",
  },
});
