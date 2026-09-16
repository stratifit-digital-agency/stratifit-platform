import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Create a Drizzle database client.
 *
 * SERVER-SIDE ONLY. The connection string must never reach the browser;
 * the ESLint boundary rules prevent `@stratifit/database` from being
 * imported by the public Media app entirely.
 */
export const createDatabase = (connectionString: string): Database => {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
};

export { schema };
