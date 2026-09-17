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
  AuditAppend,
  IdentityRepository,
  MembershipRecord,
  MembershipRepository,
  MembershipStatus,
  MembershipTransaction,
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

/**
 * D2.4-1: the four mutating operations parameterized by executor so they can
 * run against the root connection OR a transaction connection — identical SQL
 * either way. The audit row is appended by the injected `auditWriter` on the
 * SAME transaction connection (see runInTransaction).
 */
const mutationsFor = (exec: Database) => ({
  insertTeam: async (input: { orgId: string; slug: string; name: string }): Promise<TeamRecord> => {
    const [row] = await exec.insert(teams).values(input).returning();
    if (!row) throw new Error("team insert returned no row");
    return toTeam(row);
  },
  updateTeamStatus: async (teamId: string, status: "archived"): Promise<TeamRecord> => {
    const [row] = await exec
      .update(teams)
      .set({ status, updatedAt: new Date() })
      .where(eq(teams.id, teamId))
      .returning();
    if (!row) throw new Error("team status update returned no row");
    return toTeam(row);
  },
  insertOrgMembership: async (
    input: {
      operatorId: string;
      organizationId?: string;
      teamId?: string;
      role?: OperatorRole;
      grantedBy?: string;
    },
  ): Promise<MembershipRecord> => {
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
    const [row] = await exec.insert(orgMemberships).values(values).returning();
    if (!row) throw new Error("membership insert returned no row");
    return toMembership(row);
  },
  updateMembershipStatus: async (
    id: string,
    status: MembershipStatus,
    revokedAt: Date | null,
  ): Promise<MembershipRecord> => {
    const [row] = await exec
      .update(orgMemberships)
      .set({ status, revokedAt, updatedAt: new Date() })
      .where(eq(orgMemberships.id, id))
      .returning();
    if (!row) throw new Error("membership status update returned no row");
    return toMembership(row);
  },
});

export interface DrizzleMembershipRepositoryDeps {
  db?: Database;
  databaseUrl?: string;
  /**
   * D2.4-1 (required): the admin-audit transaction writer (structural type;
   * composition roots pass `createAdminAuditService(...).transactionWriter()`).
   * Security-critical mutations cannot commit without their audit record.
   */
  auditWriter: { appendWithin(tx: Database, entry: Parameters<AuditAppend>[0]): Promise<void> };
}

export const createDrizzleMembershipRepository = (
  deps: DrizzleMembershipRepositoryDeps,
): MembershipRepository => {
  const db = deps.db ?? createDatabase(deps.databaseUrl as string);
  const direct = mutationsFor(db);

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

    insertTeam: (input) => direct.insertTeam(input),

    updateTeamStatus: (teamId, status) => direct.updateTeamStatus(teamId, status),

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

    insertOrgMembership: (input) => direct.insertOrgMembership(input),

    updateMembershipStatus: (id, status, revokedAt) => direct.updateMembershipStatus(id, status, revokedAt),

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
    },    async listTeamAssignments(teamId, includeRevoked) {
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

    /**
     * D2.4-1 Option A: the membership mutation and its audit record run on the
     * SAME transaction connection — a crash before COMMIT rolls back both, and
     * the mutation cannot commit without its audit row. The audit INSERT is
     * delegated to the injected admin-audit writer (structural type), which
     * executes on `tx` and never commits.
     */
    runInTransaction: async <T>(work: (tx: MembershipTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (trx) => {
        const exec = trx as unknown as Database;
        const mutations = mutationsFor(exec);
        const scoped: MembershipTransaction = {
          insertTeam: (input) => mutations.insertTeam(input),
          updateTeamStatus: (teamId, status) => mutations.updateTeamStatus(teamId, status),
          insertOrgMembership: (input) => mutations.insertOrgMembership(input),
          updateMembershipStatus: (id, status, revokedAt) => mutations.updateMembershipStatus(id, status, revokedAt),
          appendAudit: (entry) => deps.auditWriter.appendWithin(exec, entry),
        };
        return work(scoped);
      }),
  };
};
