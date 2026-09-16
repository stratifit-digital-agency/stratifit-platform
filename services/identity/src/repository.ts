/**
 * Durable identity-state adapter over @stratifit/database (Drizzle).
 *
 * services/identity owns the identity table families (SERVICE_ARCHITECTURE
 * section 11): organizations, operators, audience_users,
 * verification_requirements. All access is parameterized; the default-org
 * binding for audience users is applied at insert time (D1 tenancy).
 */
import { and, eq } from "drizzle-orm";
import {
  audienceUsers,
  createDatabase,
  operators,
  organizations,
  type Database,
} from "@stratifit/database";
import type { OperatorRole } from "@stratifit/auth";
import type { IdentityRepository } from "./types";

const OPERATOR_ROLES = ["admin", "operator", "reviewer", "viewer"] as const;

const toRoles = (raw: string[]): readonly OperatorRole[] =>
  raw.filter((r): r is OperatorRole => (OPERATOR_ROLES as readonly string[]).includes(r));

export interface DrizzleIdentityRepositoryDeps {
  /** Existing Drizzle database (Control composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (public fragment composition). */
  databaseUrl?: string;
  /** Default organization slug for audience JIT provisioning (D1). */
  defaultOrgSlug?: string;
}

export const createDrizzleIdentityRepository = (
  deps: DrizzleIdentityRepositoryDeps,
): IdentityRepository & { readonly db: Database } => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const defaultOrgSlug = deps.defaultOrgSlug ?? "stratifit";

  const loadDefaultOrgId = async (): Promise<string> => {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, defaultOrgSlug))
      .limit(1);
    if (!org) throw new Error(`default organization '${defaultOrgSlug}' is not seeded`);
    return org.id;
  };

  return {
    db,

    async findOperatorBySubject(subject) {
      const [row] = await db
        .select({
          id: operators.id,
          orgId: operators.orgId,
          email: operators.email,
          displayName: operators.displayName,
          roles: operators.roles,
        })
        .from(operators)
        .where(and(eq(operators.authSubjectRef, subject), eq(operators.status, "active")))
        .limit(1);
      if (!row) return null;
      return { ...row, roles: toRoles(row.roles) };
    },

    async findAudienceBySubject(subject) {
      const [row] = await db
        .select({
          id: audienceUsers.id,
          orgId: audienceUsers.orgId,
          email: audienceUsers.email,
          emailVerified: audienceUsers.emailVerified,
        })
        .from(audienceUsers)
        .where(and(eq(audienceUsers.authSubjectRef, subject), eq(audienceUsers.status, "active")))
        .limit(1);
      return row ?? null;
    },

    async upsertAudienceUser(input) {
      const orgId = await loadDefaultOrgId();
      const [row] = await db
        .insert(audienceUsers)
        .values({
          orgId,
          authSubjectRef: input.authSubjectRef,
          email: input.email,
          emailVerified: input.emailVerified,
        })
        .onConflictDoUpdate({
          target: audienceUsers.authSubjectRef,
          set: { email: input.email, emailVerified: input.emailVerified, updatedAt: new Date() },
        })
        .returning({
          id: audienceUsers.id,
          orgId: audienceUsers.orgId,
          email: audienceUsers.email,
          emailVerified: audienceUsers.emailVerified,
        });
      if (!row) throw new Error("audience user upsert returned no row");
      return row;
    },
  };
};
