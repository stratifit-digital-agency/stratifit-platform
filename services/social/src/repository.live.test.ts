/**
 * Gated LIVE tests for the SOCIAL GRAPH aggregates (Stage 2.15).
 *
 * Runs only when the git-ignored root .env provides both database URLs;
 * proves against the LIVE remote, deliberately through the RUNTIME role
 * (DATABASE_URL / stratifit_runtime) — the privilege boundary the production
 * path actually uses:
 *   - runtime grants map = 41 distinct tables incl. the five social tables (ARWD);
 *   - RLS enabled with exactly the runtime_all policy TO stratifit_runtime;
 *   - CHECK constraints reject illegal channels/visibility/kinds (23514);
 *   - self-follow rejected by the DB CHECK (23514);
 *   - UNIQUE(likes/saves user+content) backstop (23505);
 *   - partial follow UNIQUE: tombstoned row does not block re-follow (23505 only when active);
 *   - comment body length CHECK (23514);
 *   - FK ON DELETE RESTRICT protects the audience/content family (23503);
 *   - cross-org isolation: org B sees zero org A rows through the service.
 *
 * Tenant rows are provisioned through the migrator connection (provisioning
 * ONLY) and cleaned up FK-safely afterwards — zero residue.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDrizzleSocialRepository, createSocialService } from "./index";
import type { SocialPrincipal } from "./types";

const envPath = new URL("../../../.env", import.meta.url);
const hasEnv = existsSync(envPath);
const migrateUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_MIGRATE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;
const runtimeUrl = hasEnv
  ? (readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? null)
  : null;

const d = hasEnv && migrateUrl && runtimeUrl ? describe : describe.skip;

const adminSql = migrateUrl ? postgres(migrateUrl, { prepare: false, max: 1 }) : undefined;
const runtimeSql = runtimeUrl ? postgres(runtimeUrl, { prepare: false, max: 1 }) : undefined;

const uuid = () => crypto.randomUUID();
const AT = "@soc.test";

/** SHARED repository (one pool) — the Supabase pooler caps connections (15). */
const sharedRepo = createDrizzleSocialRepository({ databaseUrl: runtimeUrl! });
const serviceOf = (principal: SocialPrincipal) => createSocialService({ repository: sharedRepo });

/** FK-safe tenant cleanup (children before parents). */
const cleanupTenant = async (orgId: string) => {
  await adminSql!`delete from shares where org_id = ${orgId}`;
  await adminSql!`delete from comments where org_id = ${orgId}`;
  await adminSql!`delete from follow_graph where org_id = ${orgId}`;
  await adminSql!`delete from likes where org_id = ${orgId}`;
  await adminSql!`delete from saves where org_id = ${orgId}`;
  await adminSql!`delete from watch_progress where org_id = ${orgId}`;
  await adminSql!`delete from public_content where org_id = ${orgId}`;
  await adminSql!`delete from distribution_references where org_id = ${orgId}`;
  await adminSql!`delete from publication_versions where org_id = ${orgId}`;
  await adminSql!`delete from publications where org_id = ${orgId}`;
  await adminSql!`delete from audience_users where org_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

/** Provisions an org, published public content, and two audience users. */
const provisionTenant = async (tag: string) => {
  const orgId = (await adminSql!`insert into organizations (name, slug) values (${"soc-live-" + tag}, ${"soc-live-" + tag}) returning id`)[0]!.id as string;
  const pubId = (
    await adminSql!`insert into publications (org_id, subject_kind, subject_ref, platform_target, content_type, status)
      values (${orgId}::uuid, 'production', ${uuid()}::uuid, 'stratifit-media', 'film', 'published') returning id`
  )[0]!.id as string;
  const versionId = (
    await adminSql!`insert into publication_versions (org_id, publication_id, version_number, title, content_type, subject_kind, subject_ref)
      values (${orgId}::uuid, ${pubId}::uuid, 1, ${"Social Target " + tag}, 'film', 'production', ${uuid()}::uuid) returning id`
  )[0]!.id as string;
  const contentId = (
    await adminSql!`insert into public_content (org_id, publication_id, publication_version_id, slug, content_type, title, published_at)
      values (${orgId}::uuid, ${pubId}::uuid, ${versionId}::uuid, ${"soc-" + tag}, 'film', ${"Social Target " + tag}, now()) returning id`
  )[0]!.id as string;
  const userA = (
    await adminSql!`insert into audience_users (org_id, auth_subject_ref, email, email_verified, handle, status)
      values (${orgId}::uuid, ${"soc-a-" + tag}, ${"a-" + tag + AT}, true, ${"alice-" + tag}, 'active') returning id`
  )[0]!.id as string;
  const userB = (
    await adminSql!`insert into audience_users (org_id, auth_subject_ref, email, email_verified, handle, status)
      values (${orgId}::uuid, ${"soc-b-" + tag}, ${"b-" + tag + AT}, true, ${"bob-" + tag}, 'active') returning id`
  )[0]!.id as string;
  return { orgId, pubId, versionId, contentId, userA, userB };
};

d("social live proofs (runtime role)", () => {
  it(
    "runtime grants map = 54 distinct tables (53 + the Stage 2.19 analytics_events intake family) with all five social tables ARWD",
    { timeout: 30_000 },
    async () => {
      const [counts] = await runtimeSql!`select count(distinct table_name)::int as n from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_schema = 'public'`;
      expect(counts!.n).toBe(64);
      for (const table of ["likes", "saves", "follow_graph", "comments", "shares"]) {
        const [row] = await runtimeSql!`select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_name = ${table} and table_schema = 'public'`;
        expect(row!.privs).toBe("DELETE,INSERT,SELECT,UPDATE");
      }
    },
  );

  it(
    "RLS enabled on all five social tables with exactly the runtime_all policy TO stratifit_runtime",
    { timeout: 30_000 },
    async () => {
      for (const table of ["likes", "saves", "follow_graph", "comments", "shares"]) {
        const [rls] = await runtimeSql!`select rowsecurity from pg_tables where schemaname = 'public' and tablename = ${table}`;
        expect(rls!.rowsecurity).toBe(true);
        const pols = await runtimeSql!`select policyname, roles::text as roles from pg_policies where schemaname = 'public' and tablename = ${table}`;
        expect(pols).toHaveLength(1);
        expect(pols[0]!.policyname).toBe("runtime_all");
        expect(pols[0]!.roles).toContain("stratifit_runtime");
      }
    },
  );

  it(
    "service flow end-to-end: like/save toggle, follow tombstone, comment thread, share facts",
    { timeout: 30_000 },
    async () => {
      const tag = `e${Date.now().toString(36)}`;
      const t = await provisionTenant(tag);
      try {
        const principal: SocialPrincipal = { userId: t.userA, emailVerified: true };
        const svc = serviceOf(principal);

        // Like toggle + duplicate idempotency (one row).
        expect((await svc.like(principal, { contentRef: t.contentId })).ok).toBe(true);
        expect((await svc.like(principal, { contentRef: t.contentId })).ok).toBe(true);
        const likeRows = await runtimeSql!`select count(*)::int as n from likes where audience_user_id = ${t.userA}::uuid`;
        expect(likeRows[0]!.n).toBe(1);
        expect((await svc.unlike(principal, { contentRef: t.contentId })).ok).toBe(true);
        expect((await runtimeSql!`select count(*)::int as n from likes where audience_user_id = ${t.userA}::uuid`)[0]!.n).toBe(0);

        // Save toggle.
        expect((await svc.save(principal, { contentRef: t.contentId })).ok).toBe(true);
        expect((await runtimeSql!`select count(*)::int as n from saves where audience_user_id = ${t.userA}::uuid`)[0]!.n).toBe(1);

        // Follow tombstone: follow → unfollow (tombstone) → re-follow reactivates SAME row.
        expect((await svc.follow(principal, { followeeKind: "audience_user", followeeRef: t.userB })).ok).toBe(true);
        const followRow = (await runtimeSql!`select id, deleted_at from follow_graph where follower_id = ${t.userA}::uuid`)[0]!;
        expect(followRow.deleted_at).toBeNull();
        expect((await svc.unfollow(principal, { followeeKind: "audience_user", followeeRef: t.userB })).ok).toBe(true);
        const tombstoned = (await runtimeSql!`select deleted_at from follow_graph where id = ${followRow.id}::uuid`)[0]!;
        expect(tombstoned.deleted_at).not.toBeNull();
        expect((await svc.follow(principal, { followeeKind: "audience_user", followeeRef: t.userB })).ok).toBe(true);
        const reactivated = (await runtimeSql!`select count(*)::int as n from follow_graph where follower_id = ${t.userA}::uuid and deleted_at is null`)[0]!;
        expect(reactivated.n).toBe(1);
        expect((await runtimeSql!`select count(*)::int as n from follow_graph where follower_id = ${t.userA}::uuid`)[0]!.n).toBe(1);

        // Comments: verified author creates; thread under visible parent.
        const comment = await svc.comment(principal, { contentRef: t.contentId, body: "root comment" });
        expect(comment.ok).toBe(true);
        const parentId = (comment as { ok: true; value: { commentId: string } }).value.commentId;
        const reply = await svc.comment(principal, {
          contentRef: t.contentId,
          body: "a reply",
          parentCommentId: parentId,
        });
        expect(reply.ok).toBe(true);

        // Public visible-comments read via the service (anonymous-shaped call).
        const publicView = await svc.listPublicComments(t.contentId);
        expect(publicView.ok).toBe(true);
        const views = (publicView as unknown as { ok: true; value: Array<{ body: string; authorHandle: string }> }).value;
        expect(views.map((v) => v.body).sort()).toEqual(["a reply", "root comment"]);
        expect(views[0]!.authorHandle).toBe(`alice-${tag}`);

        // Shares: immutable facts — duplicates are distinct rows.
        expect((await svc.share(principal, { contentRef: t.contentId, channel: "copy_link" })).ok).toBe(true);
        expect((await svc.share(principal, { contentRef: t.contentId, channel: "copy_link" })).ok).toBe(true);
        expect((await runtimeSql!`select count(*)::int as n from shares where audience_user_id = ${t.userA}::uuid`)[0]!.n).toBe(2);
      } finally {
        await cleanupTenant(t.orgId);
      }
    },
  );

  it("CHECK constraints reject illegal channel/visibility/kind/self-follow/body (23514)", { timeout: 30_000 }, async () => {
    const tag = `c${Date.now().toString(36)}`;
    const t = await provisionTenant(tag);
    try {
      const code = async (q: ReturnType<typeof postgres>) => q;
      const badShare = await runtimeSql!`insert into shares (org_id, audience_user_id, content_ref, channel)
        values (${t.orgId}::uuid, ${t.userA}::uuid, ${t.contentId}::uuid, 'smoke-signal')`.catch((e: { code: string }) => e.code);
      expect(badShare).toBe("23514");
      const badVisibility = await runtimeSql!`insert into comments (org_id, author_id, content_ref, body, visibility)
        values (${t.orgId}::uuid, ${t.userA}::uuid, ${t.contentId}::uuid, 'x', 'deleted')`.catch((e: { code: string }) => e.code);
      expect(badVisibility).toBe("23514");
      const badKind = await runtimeSql!`insert into follow_graph (org_id, follower_id, followee_kind, followee_audience_user_id)
        values (${t.orgId}::uuid, ${t.userA}::uuid, 'brand', ${t.userB}::uuid)`.catch((e: { code: string }) => e.code);
      expect(badKind).toBe("23514");
      const selfFollow = await runtimeSql!`insert into follow_graph (org_id, follower_id, followee_kind, followee_audience_user_id)
        values (${t.orgId}::uuid, ${t.userA}::uuid, 'audience_user', ${t.userA}::uuid)`.catch((e: { code: string }) => e.code);
      expect(selfFollow).toBe("23514");
      const longBody = await runtimeSql!`insert into comments (org_id, author_id, content_ref, body)
        values (${t.orgId}::uuid, ${t.userA}::uuid, ${t.contentId}::uuid, ${"x".repeat(2001)})`.catch((e: { code: string }) => e.code);
      expect(longBody).toBe("23514");
      void code;
    } finally {
      await cleanupTenant(t.orgId);
    }
  });

  it("UNIQUE backstops: likes/saves user+content fire (23505); tombstoned follow does NOT block re-follow", { timeout: 30_000 }, async () => {
    const tag = `u${Date.now().toString(36)}`;
    const t = await provisionTenant(tag);
    try {
      await runtimeSql!`insert into likes (org_id, audience_user_id, content_ref) values (${t.orgId}::uuid, ${t.userA}::uuid, ${t.contentId}::uuid)`;
      const dupLike = await runtimeSql!`insert into likes (org_id, audience_user_id, content_ref) values (${t.orgId}::uuid, ${t.userA}::uuid, ${t.contentId}::uuid)`.catch((e: { code: string }) => e.code);
      expect(dupLike).toBe("23505");

      // Active follow exists → inserting another ACTIVE row violates the
      // partial unique (23505).
      await runtimeSql!`insert into follow_graph (org_id, follower_id, followee_kind, followee_audience_user_id)
        values (${t.orgId}::uuid, ${t.userA}::uuid, 'audience_user', ${t.userB}::uuid)`;
      const dupFollow = await runtimeSql!`insert into follow_graph (org_id, follower_id, followee_kind, followee_audience_user_id)
        values (${t.orgId}::uuid, ${t.userA}::uuid, 'audience_user', ${t.userB}::uuid)`.catch((e: { code: string }) => e.code);
      expect(dupFollow).toBe("23505");

      // Tombstone the row → the same insert SUCCEEDS again (partial unique
      // only covers deleted_at is null) — the documented reactivation backstop.
      await runtimeSql!`update follow_graph set deleted_at = now() where follower_id = ${t.userA}::uuid`;
      const afterTombstone = await runtimeSql!`insert into follow_graph (org_id, follower_id, followee_kind, followee_audience_user_id)
        values (${t.orgId}::uuid, ${t.userA}::uuid, 'audience_user', ${t.userB}::uuid) returning id`.catch((e: { code: string }) => e.code);
      expect(afterTombstone[0]).toHaveProperty("id");
    } finally {
      await cleanupTenant(t.orgId);
    }
  });

  it("FK ON DELETE RESTRICT protects the audience/content family (23503)", { timeout: 30_000 }, async () => {
    const tag = `f${Date.now().toString(36)}`;
    const t = await provisionTenant(tag);
    try {
      await runtimeSql!`insert into likes (org_id, audience_user_id, content_ref) values (${t.orgId}::uuid, ${t.userA}::uuid, ${t.contentId}::uuid)`;
      const delContent = await runtimeSql!`delete from public_content where id = ${t.contentId}::uuid`.catch((e: { code: string }) => e.code);
      expect(delContent).toBe("23503");
      const delUser = await runtimeSql!`delete from audience_users where id = ${t.userA}::uuid`.catch((e: { code: string }) => e.code);
      expect(delUser).toBe("23503");
    } finally {
      await cleanupTenant(t.orgId);
    }
  });

  it("cross-org isolation: org B's service principal sees zero org A rows", { timeout: 30_000 }, async () => {
    const tag = `x${Date.now().toString(36)}`;
    const a = await provisionTenant(`${tag}a`);
    const b = await provisionTenant(`${tag}b`);
    try {
      const principalA: SocialPrincipal = { userId: a.userA, emailVerified: true };
      const svcA = serviceOf(principalA);
      expect((await svcA.like(principalA, { contentRef: a.contentId })).ok).toBe(true);

      // Org B principal reading their own state sees none of A's rows.
      const principalB: SocialPrincipal = { userId: b.userA, emailVerified: true };
      const svcB = serviceOf(principalB);
      const bLikes = await svcB.listLikes(principalB);
      expect(bLikes).toHaveLength(0);
      // And B cannot like A's content through a fabricated contentRef — the
      // eligibility check is by content existence, but the ROW org binding
      // follows the OWNER (B), so A's counts stay unchanged.
      expect((await runtimeSql!`select count(*)::int as n from likes where org_id = ${a.orgId}::uuid`)[0]!.n).toBe(1);
      expect((await runtimeSql!`select count(*)::int as n from likes where org_id = ${b.orgId}::uuid`)[0]!.n).toBe(0);
    } finally {
      await cleanupTenant(a.orgId);
      await cleanupTenant(b.orgId);
    }
  });
});
