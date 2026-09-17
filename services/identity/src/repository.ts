/**
 * Durable identity-state adapter over @stratifit/database (Drizzle).
 *
 * services/identity owns the identity table families (SERVICE_ARCHITECTURE
 * section 11): organizations, teams, org_memberships, operators,
 * audience_users, verification_requirements. All access is parameterized; the
 * default-org binding for audience users is applied at insert time (D1).
 *
 * Stage 2.2: authorization facts come from org_memberships (D-1) — the
 * operator lookup below deliberately carries NO role data.
 */
import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
  audienceUsers,
  createDatabase,
  operators,
  organizations,
  orgMemberships,
  teams,
  type Database,
  type OrgMembershipRow,
  type TeamRow,
} from "@stratifit/database";
import type { OperatorRole } from "@stratifit/auth";
import type {
  IdentityRepository,
  MembershipRecord,
  MembershipRepository,
  MembershipStatus,
  OperatorAuthorizationLookup,
  TeamRecord,
} from "./types";

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

    /** Row lookup ONLY — no authorization data (D-1). Status included for fail-closed checks. */
    async findOperatorBySubject(subject) {
      const [row] = await db
        .select({
          id: operators.id,
          email: operators.email,
          displayName: operators.displayName,
          status: operators.status,
        })
        .from(operators)
        .where(eq(operators.authSubjectRef, subject))
        .limit(1);
      return row ?? null;
    },

    /** Joined authorization facts for the fail-closed decision (D-2). */
    async findOperatorAuthorization(operatorId): Promise<OperatorAuthorizationLookup | null> {
      const [row] = await db
        .select({
          operatorStatus: operators.status,
          organizationId: organizations.id,
          organizationStatus: organizations.status,
          membershipId: orgMemberships.id,
          membershipRole: orgMemberships.role,
          membershipStatus: orgMemberships.status,
        })
        .from(operators)
        .innerJoin(organizations, eq(organizations.id, operators.orgId))
        .leftJoin(
          orgMemberships,
          and(
            eq(orgMemberships.operatorId, operators.id),
            eq(orgMemberships.organizationId, operators.orgId),
            eq(orgMemberships.status, "active"),
          ),
        )
        .where(eq(operators.id, operatorId))
        .limit(1);
      if (!row) return null;
      const role = row.membershipRole ? toRoles([row.membershipRole])[0] : undefined;
      return {
        operatorStatus: row.operatorStatus,
        organizationId: row.organizationId,
        organizationStatus: row.organizationStatus,
        orgMembership:
          row.membershipId && role
            ? { id: row.membershipId, role, status: row.membershipStatus ?? "" }
            : null,
      };
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

// ---------------------------------------------------------------------------
// Membership repository (Stage 2.2)
// ---------------------------------------------------------------------------

const toMembership = (row: OrgMembershipRow): MembershipRecord => ({
  id: row.id,
  operatorId: row.operatorId,
  organizationId: row.organizationId,
  teamId: row.teamId,
  role: row.role ? (toRoles([row.role])[0] ?? null) : null,
  // Status vocabulary is DB-constrained by org_memberships_status_check.
  status: row.status as MembershipStatus,
  grantedBy: row.grantedBy,
  grantedAt: row.grantedAt.toISOString(),
  revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
});

const toTeam = (row: TeamRow): TeamRecord => ({
  id: row.id,
  orgId: row.orgId,
  slug: row.slug,
  name: row.name,
  // Status vocabulary is DB-constrained by teams_status_check.
  status: row.status as TeamRecord["status"],
});

export const createDrizzleMembershipRepository = (
  deps: { db?: Database; databaseUrl?: string } = {},
): MembershipRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);

  return {
    async findOperatorById(id) {
      const [row] = await db
        .select({ id: operators.id, orgId: operators.orgId, status: operators.status })
        .from(operators)
        .where(eq(operators.id, id))
        .limit(1);
      return row ?? null;
    },

    async findOrganizationStatus(orgId) {
      const [row] = await db
        .select({ status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      return row?.status ?? null;
    },

    async findTeamById(teamId) {
      const [row] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
      return row ? toTeam(row) : null;
    },

    async findTeamBySlug(orgId, slug) {
      const [row] = await db
        .select()
        .from(teams)
        .where(and(eq(teams.orgId, orgId), eq(teams.slug, slug)))
        .limit(1);
      return row ? toTeam(row) : null;
    },

    async insertTeam(input) {
      const [row] = await db.insert(teams).values(input).returning();
      if (!row) throw new Error("team insert returned no row");
      return toTeam(row);
    },

    async updateTeamStatus(teamId, status) {
      const [row] = await db
        .update(teams)
        .set({ status, updatedAt: new Date() })
        .where(eq(teams.id, teamId))
        .returning();
      if (!row) throw new Error("team status update returned no row");
      return toTeam(row);
    },

    async listTeamsByOrg(orgId) {
      const rows = await db
        .select()
        .from(teams)
        .where(eq(teams.orgId, orgId))
        .orderBy(asc(teams.slug));
      return rows.map(toTeam);
    },

    async findNonRevokedOrgMembership(operatorId, organizationId) {
      const [row] = await db
        .select()
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.operatorId, operatorId),
            eq(orgMemberships.organizationId, organizationId),
            ne(orgMemberships.status, "revoked"),
          ),
        )
        .orderBy(desc(orgMemberships.grantedAt))
        .limit(1);
      return row ? toMembership(row) : null;
    },

    async findNonRevokedTeamMembership(operatorId, teamId) {
      const [row] = await db
        .select()
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.operatorId, operatorId),
            eq(orgMemberships.teamId, teamId),
            ne(orgMemberships.status, "revoked"),
          ),
        )
        .orderBy(desc(orgMemberships.grantedAt))
        .limit(1);
      return row ? toMembership(row) : null;
    },

    async findMembershipById(id) {
      const [row] = await db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.id, id))
        .limit(1);
      return row ? toMembership(row) : null;
    },

    async insertOrgMembership(input) {
      const values =
        input.teamId !== undefined
          ? {
              operatorId: input.operatorId,
              teamId: input.teamId,
              grantedBy: input.grantedBy,
            }
          : {
              operatorId: input.operatorId,
              organizationId: input.organizationId as string,
              role: input.role as string,
              grantedBy: input.grantedBy,
            };
      const [row] = await db.insert(orgMemberships).values(values).returning();
      if (!row) throw new Error("membership insert returned no row");
      return toMembership(row);
    },

    async updateMembershipStatus(id, status, revokedAt) {
      const [row] = await db
        .update(orgMemberships)
        .set({ status, revokedAt, updatedAt: new Date() })
        .where(eq(orgMemberships.id, id))
        .returning();
      if (!row) throw new Error("membership status update returned no row");
      return toMembership(row);
    },

    async listMembershipsForOrg(orgId, includeRevoked) {
      const rows = await db
        .select()
        .from(orgMemberships)
        .where(
          includeRevoked
            ? eq(orgMemberships.organizationId, orgId)
            : and(eq(orgMemberships.organizationId, orgId), ne(orgMemberships.status, "revoked")),
        )
        .orderBy(desc(orgMemberships.grantedAt));
      return rows.map(toMembership);
    },

    async listTeamAssignments(teamId, includeRevoked) {
      const rows = await db
        .select()
        .from(orgMemberships)
        .where(
          includeRevoked
            ? eq(orgMemberships.teamId, teamId)
            : and(eq(orgMemberships.teamId, teamId), ne(orgMemberships.status, "revoked")),
        )
        .orderBy(desc(orgMemberships.grantedAt));
      return rows.map(toMembership);
    },
  };
};
