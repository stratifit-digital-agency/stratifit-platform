import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schemaExports from "./schema";
import {
  audienceUsers,
  operators,
  organizations,
  platformConfig,
  verificationRequirements,
} from "./schema";

/**
 * Shape guards for the Stage 2.3 identity foundation (approved decisions D1–D4).
 * These lock the approved structure; the domain-table guard keeps DOMAIN_MODEL
 * families out until their increments are separately approved.
 */

const identityTables = { organizations, operators, audienceUsers, verificationRequirements };

describe("identity foundation (Stage 2.3, approved shape)", () => {
  it("exposes exactly the four identity tables plus platform_config", () => {
    const exported = Object.keys(schemaExports).filter(
      (k) => !k.endsWith("Row") && !k.startsWith("New"),
    );
    expect(exported.sort()).toEqual(
      [
        "audienceUsers",
        "operators",
        "organizations",
        "platformConfig",
        "verificationRequirements",
      ].sort(),
    );
  });

  it("organizations: tenancy root with unique slug, no org_id", () => {
    const cols = Object.keys(getTableColumns(organizations)).sort();
    expect(cols).toEqual(["createdAt", "id", "name", "slug", "status", "updatedAt"]);
  });

  it("operators: org_id NOT NULL, unique auth subject, roles subset", () => {
    const c = getTableColumns(operators);
    expect(Object.keys(c).sort()).toEqual(
      ["authSubjectRef", "createdAt", "displayName", "email", "id", "orgId", "roles", "status", "updatedAt"],
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.authSubjectRef.notNull).toBe(true);
    expect(c.authSubjectRef.isUnique).toBe(true);
    expect(c.email.notNull).toBe(true);
  });

  it("audience_users: org_id NOT NULL, unique auth subject, email-verified mirror", () => {
    const c = getTableColumns(audienceUsers);
    expect(Object.keys(c).sort()).toEqual(
      ["authSubjectRef", "createdAt", "email", "emailVerified", "handle", "id", "orgId", "status", "updatedAt"],
    );
    expect(c.orgId.notNull).toBe(true);
    expect(c.authSubjectRef.isUnique).toBe(true);
    expect(c.emailVerified.notNull).toBe(true);
  });

  it("verification_requirements: platform-level (no org_id)", () => {
    const cols = Object.keys(getTableColumns(verificationRequirements)).sort();
    expect(cols).toEqual(["action", "createdAt", "requiredVerifications", "updatedAt"]);
  });

  it("every identity table is created with RLS enabled and no policies (deny-by-default)", () => {
    const migrationsDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const sqlText = files.map((f) => readFileSync(`${migrationsDir}/${f}`, "utf8")).join("\n");
    for (const table of ["organizations", "operators", "audience_users", "verification_requirements"]) {
      expect(sqlText).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    }
    // Zero policies: deny-by-default. No policy statements may exist for these tables.
    expect(sqlText).not.toMatch(/CREATE POLICY[^(]*(?:organizations|operators|audience_users|verification_requirements)/);
  });

  it("platform_config remains exactly the approved foundational shape", () => {
    const cols = Object.keys(getTableColumns(platformConfig)).sort();
    expect(cols).toEqual(["createdAt", "id", "key", "updatedAt", "value"]);
  });
});

describe("domain-table guard (per approved plan)", () => {
  it("contains no domain tables yet", () => {
    const exported = Object.keys(schemaExports);
    const forbidden = [
      "productions",
      "scenes",
      "shots",
      "assets",
      "generations",
      "publications",
      "aiCreators",
      "conversations",
      "messages",
      "auditLogs",
    ];
    for (const name of forbidden) expect(exported).not.toContain(name);
  });
});
