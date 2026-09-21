/**
 * Gated LIVE tests for the MESSAGING & LEADS aggregates (Stage 2.17).
 *
 * Runs only when the git-ignored root .env provides both database URLs;
 * proves against the LIVE remote through the RUNTIME role (DATABASE_URL /
 * stratifit_runtime) — the privilege boundary production uses:
 *   - runtime grants map = 53 distinct tables incl. the six Messaging tables
 *     (conversations/messages/service_offerings/service_inquiries = ARWD;
 *     messages/lead_follow_ups = INSERT+SELECT immutable family);
 *   - RLS enabled with exactly the runtime_all policy TO stratifit_runtime;
 *   - conversation/lead status CHECKs (23514);
 *   - immutable families: UPDATE/DELETE on messages and lead_follow_ups are
 *     permission-denied (42501) and rows remain unchanged;
 *   - body CHECK (23514), one-lead-per-conversation partial unique (23505);
 *   - cross-org / cross-owner isolation through the service.
 *
 * Tenant rows are provisioned through the migrator connection (provisioning
 * ONLY) and cleaned up FK-safely afterwards — zero residue.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDrizzleMessagingRepository, createMessagingService } from "./index";
import type { MessagingAudiencePrincipal, MessagingOperatorPrincipal } from "./types";

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

/** Test-only D2.4-1 writer (same mapping as the Control composition root). */
const createTestAuditWriter = (url: string) => {
  const admin = postgres(url, { prepare: false, max: 1 });
  return {
    appendWithin: async (
      _tx: unknown,
      entry: {
        actorId: string;
        action: string;
        targetType: string;
        targetId: string;
        organizationId?: string | null;
        metadata?: Record<string, unknown>;
        correlationId?: string | null;
        causationId?: string | null;
      },
    ): Promise<void> => {
      await admin`
        insert into audit_log (actor_id, action, subject_kind, subject_id, organization_id, correlation_id, causation_id, payload)
        values (${entry.actorId}::uuid, ${entry.action}, ${entry.targetType}, ${entry.targetId}::uuid,
                ${entry.organizationId ?? null}::uuid, ${entry.correlationId ?? null}, ${entry.causationId ?? null},
                ${JSON.stringify(entry.metadata ?? {})}::jsonb)`;
    },
  };
};

/** SHARED repo/audit writer (one pool each) — the pooler caps connections (15). */
const sharedRepo = createDrizzleMessagingRepository({
  databaseUrl: runtimeUrl!,
  auditWriter: createTestAuditWriter(runtimeUrl!),
});

const runTag = () => Math.random().toString(36).slice(2, 8);

/** FK-safe subtree wipe for one tenant (provisioned rows only). */
const wipeTenant = async (orgId: string) => {
  await adminSql!`delete from audit_log where organization_id = ${orgId}`;
  await adminSql!`delete from lead_follow_ups where org_id = ${orgId}`;
  await adminSql!`delete from service_leads where org_id = ${orgId}`;
  await adminSql!`delete from service_inquiries where org_id = ${orgId}`;
  // Read-receipt FKs create a conversations↔messages cycle: detach first.
  await adminSql!`update conversations set audience_last_read_message_id = null, creator_last_read_message_id = null where org_id = ${orgId}`;
  await adminSql!`delete from messages where org_id = ${orgId}`;
  await adminSql!`delete from conversations where org_id = ${orgId}`;
  await adminSql!`delete from service_offerings where org_id = ${orgId}`;
  await adminSql!`delete from creator_profiles where org_id = ${orgId}`;
  await adminSql!`delete from publication_versions where org_id = ${orgId}`;
  await adminSql!`delete from publications where org_id = ${orgId}`;
  await adminSql!`delete from qc_reviews where org_id = ${orgId}`;
  await adminSql!`delete from audience_users where org_id = ${orgId}`;
  await adminSql!`delete from ai_creators where org_id = ${orgId}`;
  await adminSql!`delete from personas where org_id = ${orgId}`;
  await adminSql!`delete from characters where org_id = ${orgId}`;
  await adminSql!`delete from digital_humans where org_id = ${orgId}`;
  await adminSql!`delete from operators where org_id = ${orgId}`;
  await adminSql!`delete from organizations where id = ${orgId}`;
};

/** Remove subtrees left behind by interrupted prior runs (slug-tagged). */
const scrubResidue = async () => {
  const orphans = await adminSql!`select id from organizations where slug like 'msg-live-%'`;
  for (const row of orphans) await wipeTenant(row.id as string);
};

const provisionOrg = async (tag: string) => {
  const slug = `msg-live-${tag}-${runTag()}`.slice(0, 60);
  const orgId = (
    await adminSql!`insert into organizations (name, slug) values (${slug.slice(0, 60)}, ${slug}) returning id`
  )[0]!.id as string;
  return orgId;
};

const provisionAudienceUser = async (orgId: string, email: string) => {
  const subject = `auth-${runTag()}-${email}`;
  const id = (
    await adminSql!`insert into audience_users (org_id, auth_subject_ref, email, email_verified) values (${orgId}, ${subject}, ${email}, true) returning id`
  )[0]!.id as string;
  return id;
};

/** Operator principal whose operatorId is a REAL operators row
 * (lead_follow_ups.operator_id is an FK — the test mirrors production). */
const op = async (orgId: string): Promise<MessagingOperatorPrincipal> => {
  const operatorId = (
    await adminSql!`insert into operators (org_id, auth_subject_ref, email, roles) values (${orgId}, ${"op-" + runTag()}, ${("op-" + runTag()) + "@example.com"}, '{admin}') returning id`
  )[0]!.id as string;
  return { kind: "operator", operatorId, orgId, capabilities: ["messaging.takeover", "lead.assign"] };
};

const aud = (userId: string): MessagingAudiencePrincipal => ({ kind: "audience", audienceUserId: userId, emailVerified: true });

/** Seed an ACTIVE creator chain + PUBLICATION-MEDIATED active profile (the
 * People narrow seam resolves through creator_profiles). Provisioning runs on
 * the migrator connection; the ai_creator row is returned for status flips. */
const seedActiveCreator = async (orgId: string, handle: string) => {
  const dh = (
    await adminSql!`insert into digital_humans (org_id, name, status) values (${orgId}, ${"DH " + handle}, 'active') returning id`
  )[0]!.id as string;
  const ch = (
    await adminSql!`insert into characters (org_id, digital_human_id, name, status) values (${orgId}, ${dh}, ${"CH " + handle}, 'active') returning id`
  )[0]!.id as string;
  const pe = (
    await adminSql!`insert into personas (org_id, character_id, name, status) values (${orgId}, ${ch}, ${"PE " + handle}, 'active') returning id`
  )[0]!.id as string;
  const ac = (
    await adminSql!`insert into ai_creators (org_id, persona_id, handle, display_name, status) values (${orgId}, ${pe}, ${handle}, ${"AI " + handle}, 'active') returning id`
  )[0]!.id as string;
  // Publication mediation chain: QC review → publication → version → profile.
  const reviewId = (
    await adminSql!`insert into qc_reviews (org_id, subject_kind, subject_ref, status) values (${orgId}, 'publication', ${ac}, 'approved') returning id`
  )[0]!.id as string;
  const pubId = (
    await adminSql!`insert into publications (org_id, subject_kind, subject_ref, platform_target, content_type, status, qc_review_id)
                     values (${orgId}, 'ai_creator_profile', ${ac}, 'stratifit-media', 'short', 'published', ${reviewId}) returning id`
  )[0]!.id as string;
  const versionId = (
    await adminSql!`insert into publication_versions (org_id, publication_id, version_number, title, content_type, subject_kind, subject_ref)
                     values (${orgId}, ${pubId}, 1, ${handle}, 'short', 'ai_creator_profile', ${ac}) returning id`
  )[0]!.id as string;
  await adminSql!`update publications set current_version_id = ${versionId} where id = ${pubId}`;
  const profileId = (
    await adminSql!`insert into creator_profiles (org_id, ai_creator_id, publication_id, publication_version_id, handle, display_name, status)
                    values (${orgId}, ${ac}, ${pubId}, ${versionId}, ${handle}, ${"AI " + handle}, 'active') returning id`
  )[0]!.id as string;
  return { creatorId: ac, profileId };
};

d("messaging live — grants / RLS / constraints", () => {
  // One-time residue sweep from interrupted prior runs (slug-tagged orphans).
  beforeAll(async () => {
    await scrubResidue();
  }, 60_000);

  it(
    "runtime grant map = 52 distinct tables incl. the six Messaging tables (4 ARWD + 2 immutable)",
    { timeout: 30_000 },
    async () => {
      const [counts] = await runtimeSql!`select count(distinct table_name)::int as n from information_schema.role_table_grants where grantee = 'stratifit_runtime' and table_schema = 'public'`;
      expect(counts!.n).toBe(61);

    for (const t of ["conversations", "messages", "service_offerings", "service_inquiries", "service_leads", "lead_follow_ups"]) {
      const rls = (await runtimeSql!`select relrowsecurity as rls from pg_class where relname = ${t} and relnamespace = 'public'::regnamespace`)[0]!.rls as boolean;
      expect(rls).toBe(true);
      const pols = await runtimeSql!`select policyname from pg_policies where schemaname = 'public' and tablename = ${t}`;
      expect(pols.map((p) => p.policyname).sort()).toEqual(["runtime_all"]);
      const privs = (await runtimeSql!`
        select string_agg(privilege_type, ',' order by privilege_type) as privs
        from information_schema.role_table_grants
        where grantee = 'stratifit_runtime' and table_schema = 'public' and table_name = ${t}`)[0]!.privs as string;
      if (t === "messages" || t === "lead_follow_ups") {
        expect(privs.split(",")).toEqual(["INSERT", "SELECT"]);
      } else {
        expect(privs.split(",")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
      }
    }
    },
  );

  it(
    "messages are immutable at the DB level: UPDATE and DELETE denied (42501), rows unchanged",
    { timeout: 30_000 },
    async () => {
    const orgId = await provisionOrg("immutable");
    const { creatorId } = await seedActiveCreator(orgId, "immutable-ai");
    const audienceId = await provisionAudienceUser(orgId, "imm-user@example.com");
    try {
      const svc = createMessagingService({ repository: sharedRepo });
      const sent = await svc.sendMessage(aud(audienceId), { creatorHandle: "immutable-ai", body: "immutable proof" });
      if (!sent.ok) throw new Error(sent.error.message);
      const [msg] = await runtimeSql!`select id, body from messages where conversation_id = ${sent.value.conversationId}`;
      const bodyBefore = msg!.body as string;

      await expect(
        runtimeSql!`update messages set body = 'tampered' where id = ${msg!.id}`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimeSql!`delete from messages where id = ${msg!.id}`,
      ).rejects.toMatchObject({ code: "42501" });

      const [after] = await runtimeSql!`select body from messages where id = ${msg!.id}`;
      expect(after!.body).toBe(bodyBefore);

      // The status CHECK mirrors the frozen machine (23514 on garbage).
      await expect(
        adminSql!`update conversations set status = 'flying' where id = ${sent.value.conversationId}`,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        adminSql!`update messages set body = '' where id = ${msg!.id}`,
      ).rejects.toMatchObject({ code: "23514" });
      void creatorId;
    } finally {
      await wipeTenant(orgId);
    }
    },
  );

  it(
    "lead_follow_ups are immutable at the DB level: UPDATE/DELETE denied (42501); open-pair unique backstop (23505)",
    { timeout: 30_000 },
    async () => {
    const orgId = await provisionOrg("followups");
    const { creatorId, profileId } = await seedActiveCreator(orgId, "fu-ai");
    const audienceId = await provisionAudienceUser(orgId, "fu-user@example.com");
    try {
      const svc = createMessagingService({ repository: sharedRepo });
      const operator = await op(orgId);
      const sent = await svc.sendMessage(aud(audienceId), { creatorHandle: "fu-ai", body: "interested" });
      if (!sent.ok) throw new Error(sent.error.message);
      const classified = await svc.classifyInquiry(operator, {
        conversationId: sent.value.conversationId,
        messageId: sent.value.messageId,
        classification: "commission",
      });
      if (!classified.ok) throw new Error(classified.error.message);
      const lead = await svc.createLead(operator, { conversationId: sent.value.conversationId, serviceInquiryId: classified.value.id });
      if (!lead.ok) throw new Error(lead.error.message);
      const fu = await svc.recordFollowUp(operator, { leadId: lead.value.id, note: "first contact" });
      if (!fu.ok) throw new Error(fu.error.message);

      await expect(
        runtimeSql!`update lead_follow_ups set note = 'tampered' where id = ${fu.value.id}`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimeSql!`delete from lead_follow_ups where id = ${fu.value.id}`,
      ).rejects.toMatchObject({ code: "42501" });
      const [after] = await runtimeSql!`select note from lead_follow_ups where id = ${fu.value.id}`;
      expect(after!.note).toBe("first contact");

      // DB backstop for the conversation aggregate: at most ONE non-closed
      // conversation per (audience user, creator profile) pair (partial
      // unique). The one-lead-per-conversation invariant is SERVICE-enforced
      // via the conversations.lead_id pointer (unit-proven conflict).
      await expect(
        adminSql!`insert into conversations (org_id, creator_profile_id, audience_user_id, status)
                  values (${orgId}, ${profileId}, ${audienceId}, 'open')`,
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await wipeTenant(orgId);
    }
    },
  );

  it(
    "audience A cannot read or reply into audience B's thread; cross-org operator is not_found",
    { timeout: 30_000 },
    async () => {
    const orgA = await provisionOrg("iso-a");
    const orgB = await provisionOrg("iso-b");
    await seedActiveCreator(orgA, "iso-ai");
    const userA = await provisionAudienceUser(orgA, "a@example.com");
    const userB = await provisionAudienceUser(orgB, "b@example.com");
    try {
      const svc = createMessagingService({ repository: sharedRepo });
      const sent = await svc.sendMessage(aud(userA), { creatorHandle: "iso-ai", body: "private thread" });
      if (!sent.ok) throw new Error(sent.error.message);
      const conversationId = sent.value.conversationId;

      // Owner isolation: audience B fails closed with not_found.
      const read = await svc.getOwnConversation(aud(userB), conversationId);
      const reply = await svc.replyOwn(aud(userB), { conversationId, body: "intrusion" });
      expect(read.ok).toBe(false);
      expect(reply.ok).toBe(false);
      if (!read.ok) expect(read.error.reason).toBe("not_found");
      if (!reply.ok) expect(reply.error.reason).toBe("not_found");

      // Operator of org B cannot see org A's conversation.
      const fr = await svc.getConversation(await op(orgB), conversationId);
      expect(fr.ok).toBe(false);
      if (!fr.ok) expect(fr.error.reason).toBe("not_found");

      // Owner reads their own thread fine.
      const own = await svc.getOwnConversation(aud(userA), conversationId);
      expect(own.ok).toBe(true);
    } finally {
      await wipeTenant(orgA);
      await wipeTenant(orgB);
    }
    },
  );

  it(
    "service commands: inactive creator fail-closed; lead machine linear; audit rows commit with mutations",
    { timeout: 30_000 },
    async () => {
    const orgId = await provisionOrg("machine");
    const { creatorId } = await seedActiveCreator(orgId, "machine-ai");
    const audienceId = await provisionAudienceUser(orgId, "m-user@example.com");
    try {
      const svc = createMessagingService({ repository: sharedRepo });
      const operator = await op(orgId);

      // Retire the creator FIRST: handle resolution must fail closed.
      await adminSql!`update ai_creators set status = 'retired' where id = ${creatorId}`;
      const blocked = await svc.sendMessage(aud(audienceId), { creatorHandle: "machine-ai", body: "hello?" });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.reason).toBe("not_found");

      // Reactivate and proceed through the full lead machine.
      await adminSql!`update ai_creators set status = 'active' where id = ${creatorId}`;
      const sent = await svc.sendMessage(aud(audienceId), { creatorHandle: "machine-ai", body: "commission me" });
      if (!sent.ok) throw new Error(sent.error.message);
      const classified = await svc.classifyInquiry(operator, {
        conversationId: sent.value.conversationId,
        messageId: sent.value.messageId,
        classification: "commission",
      });
      if (!classified.ok) throw new Error(classified.error.message);
      const lead = await svc.createLead(operator, { conversationId: sent.value.conversationId, serviceInquiryId: classified.value.id });
      if (!lead.ok) throw new Error(lead.error.message);
      const skip = await svc.setLeadStatus(operator, { leadId: lead.value.id, status: "in_progress" });
      expect(skip.ok).toBe(false);
      for (const next of ["triaged", "assigned", "in_progress", "won"] as const) {
        const out = next === "assigned"
          ? await svc.assignLead(operator, { leadId: lead.value.id })
          : await svc.setLeadStatus(operator, { leadId: lead.value.id, status: next });
        expect(out.ok).toBe(true);
      }
      const terminal = await svc.setLeadStatus(operator, { leadId: lead.value.id, status: "lost" });
      expect(terminal.ok).toBe(false);

      // Same-transaction audit: every operator mutation left exactly its row.
      const auditRows = await runtimeSql!`
        select action from audit_log where organization_id = ${orgId} order by occurred_at`;
      const actions = auditRows.map((r) => r.action as string);
      expect(actions).toContain("messaging.inquiry_classified");
      expect(actions).toContain("messaging.lead_created");
      expect(actions).toContain("messaging.lead_assigned");
      expect(actions).toContain("messaging.lead_status_changed");
      // Audience sends carried no audit rows.
      expect(actions).not.toContain("messaging.conversation_replied");
    } finally {
      await wipeTenant(orgId);
    }
    },
  );
});
