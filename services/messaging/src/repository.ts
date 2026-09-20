/**
 * Drizzle repository adapter for the MESSAGING & LEADS aggregates (Stage 2.17).
 * Implements the MessagingRepository port from types.ts, mirroring the
 * services/people adapter conventions:
 *
 *  - `Database` (postgres.js via Drizzle) typed pool shared from the
 *    composition root (or built from a URL);
 *  - `mutationsFor` returns the SAME mutation shapes over either the shared
 *    pool or an open transaction connection; `appendAudit` REQUIRES the
 *    injected auditWriter (D2.4-1 seam) so a mutation and its audit record
 *    commit atomically — a rollback removes both;
 *  - runInTransaction exposes the SAME transaction connection to the domain
 *    mutations and the audit writer;
 *  - messages / lead_follow_ups: INSERT + SELECT only — there is deliberately
 *    NO update and NO delete path in this adapter (DM §32.8 immutability;
 *    live 42501 proofs).
 *
 * NAMING NOTE: the offering/lead tables are service_offerings/service_leads —
 * public.services/public.leads are occupied by a pre-existing foreign
 * marketing/CRM application on the shared Supabase project (authorized
 * Stage 2.17 deviation; DOMAIN_MODEL §38).
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  aiCreators,
  audienceUsers,
  conversations,
  createDatabase,
  creatorProfiles,
  leadFollowUps,
  messages,
  serviceInquiries,
  serviceLeads,
  serviceOfferings,
  type Database,
} from "@stratifit/database";
import type {
  ConversationAudienceView,
  ConversationOperatorView,
  ConversationRecord,
  ConversationStatus,
  LeadFollowUpRecord,
  LeadStatus,
  MessageRecord,
  MessageAuthorKind,
  MessageType,
  MessagingAuditWriter,
  MessagingRepository,
  MessagingTransaction,
  ServiceInquiryRecord,
  ServiceLeadRecord,
  ServiceOfferingRecord,
} from "./types";

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString());

const mapConversation = (r: typeof conversations.$inferSelect): ConversationRecord => ({
  id: r.id,
  orgId: r.orgId,
  creatorProfileId: r.creatorProfileId,
  audienceUserId: r.audienceUserId,
  subject: r.subject,
  status: r.status as ConversationStatus,
  audienceUnreadCount: r.audienceUnreadCount,
  creatorUnreadCount: r.creatorUnreadCount,
  audienceLastReadMessageId: r.audienceLastReadMessageId,
  creatorLastReadMessageId: r.creatorLastReadMessageId,
  leadId: r.leadId,
  assignedOperatorId: r.assignedOperatorId,
  takenOverAt: r.takenOverAt ? iso(r.takenOverAt) : null,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapMessage = (r: typeof messages.$inferSelect): MessageRecord => ({
  id: r.id,
  orgId: r.orgId,
  conversationId: r.conversationId,
  authorKind: r.authorKind as MessageAuthorKind,
  authorAudienceUserId: r.authorAudienceUserId,
  authorOperatorId: r.authorOperatorId,
  authorAiCreatorId: r.authorAiCreatorId,
  messageType: r.messageType as MessageType,
  body: r.body,
  createdAt: iso(r.createdAt),
});

const mapOffering = (r: typeof serviceOfferings.$inferSelect): ServiceOfferingRecord => ({
  id: r.id,
  orgId: r.orgId,
  aiCreatorId: r.aiCreatorId,
  name: r.name,
  description: r.description,
  category: r.category,
  status: r.status as "active" | "retired",
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapInquiry = (r: typeof serviceInquiries.$inferSelect): ServiceInquiryRecord => ({
  id: r.id,
  orgId: r.orgId,
  conversationId: r.conversationId,
  messageId: r.messageId,
  classification: r.classification,
  confidence: r.confidence,
  requestedServiceId: r.requestedServiceId,
  status: r.status as "open" | "converted" | "dismissed",
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapLead = (r: typeof serviceLeads.$inferSelect): ServiceLeadRecord => ({
  id: r.id,
  orgId: r.orgId,
  conversationId: r.conversationId,
  creatorProfileId: r.creatorProfileId,
  audienceUserId: r.audienceUserId,
  serviceInquiryId: r.serviceInquiryId,
  classification: r.classification,
  requestedServiceId: r.requestedServiceId,
  status: r.status as LeadStatus,
  assignedOperatorId: r.assignedOperatorId,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const mapFollowUp = (r: typeof leadFollowUps.$inferSelect): LeadFollowUpRecord => ({
  id: r.id,
  orgId: r.orgId,
  leadId: r.leadId,
  operatorId: r.operatorId,
  note: r.note,
  createdAt: iso(r.createdAt),
});

export interface DrizzleMessagingRepositoryDeps {
  /** Existing Drizzle database (composition roots may share one). */
  db?: Database;
  /** Or a raw pooler connection string (composition from env). */
  databaseUrl?: string;
  /** D2.4-1 seam: same-transaction audit writer (composition-root mapped). */
  auditWriter?: MessagingAuditWriter;
}

type AuditEntry = Parameters<MessagingAuditWriter["appendWithin"]>[1];

export const createDrizzleMessagingRepository = (deps: DrizzleMessagingRepositoryDeps): MessagingRepository => {
  const exec: Database = deps.db ?? createDatabase(deps.databaseUrl as string);

  // -------------------------------------------------------------------------
  // Mutation scope: direct (pool) or transactional. `mutationsFor` returns
  // the SAME function shapes over either connection, plus appendAudit which
  // REQUIRES the audit writer — mutations are unavailable in read-only
  // compositions (mirror of the People adapter).
  // -------------------------------------------------------------------------
  const mutationsFor = (conn: Database): MessagingTransaction => {
    const appendAudit = (entry: AuditEntry) => {
      if (!deps.auditWriter) {
        throw new Error("messaging audit writer not configured; mutations are not available in read-only compositions");
      }
      return deps.auditWriter.appendWithin(conn, entry);
    };

    return {
      findActiveCreatorByHandle: findActiveCreatorByHandle(conn),
      findActiveAiCreatorById: findActiveAiCreatorById(conn),

      findOpenConversation: (audienceUserId, creatorProfileId) =>
        conn
          .select()
          .from(conversations)
          .where(and(eq(conversations.audienceUserId, audienceUserId), eq(conversations.creatorProfileId, creatorProfileId), sql`status <> 'closed'`))
          .limit(1)
          .then((rows) => (rows[0] ? mapConversation(rows[0]) : null)),
      findConversationById: (id) =>
        conn.select().from(conversations).where(eq(conversations.id, id)).limit(1).then((r) => (r[0] ? mapConversation(r[0]) : null)),
      insertConversation: (input) =>
        conn
          .insert(conversations)
          .values({
            orgId: input.orgId,
            creatorProfileId: input.creatorProfileId,
            audienceUserId: input.audienceUserId,
            subject: input.subject,
            status: "open",
          })
          .returning()
          .then((r) => mapConversation(r[0]!)),
      applyAudienceMessage: async (conversationId, messageId) => {
        const [row] = await conn
          .update(conversations)
          .set({
            creatorUnreadCount: sql`${conversations.creatorUnreadCount} + 1`,
            audienceLastReadMessageId: messageId,
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversationId))
          .returning();
        return row ? mapConversation(row) : null;
      },
      applyOperatorMessage: async (conversationId, messageId) => {
        const [row] = await conn
          .update(conversations)
          .set({
            audienceUnreadCount: sql`${conversations.audienceUnreadCount} + 1`,
            creatorLastReadMessageId: messageId,
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversationId))
          .returning();
        return row ? mapConversation(row) : null;
      },
      setConversationStatus: async (id, status) => {
        const [row] = await conn
          .update(conversations)
          .set({ status, updatedAt: new Date() })
          .where(eq(conversations.id, id))
          .returning();
        return row ? mapConversation(row) : null;
      },
      applyAudienceReceipt: async (conversationId, messageId) => {
        const [row] = await conn
          .update(conversations)
          .set({
            audienceLastReadMessageId: messageId,
            audienceUnreadCount: 0,
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversationId))
          .returning();
        return row ? mapConversation(row) : null;
      },
      recordTakeover: async (conversationId, operatorId, takenOverAt) => {
        const [row] = await conn
          .update(conversations)
          .set({
            status: "active",
            assignedOperatorId: operatorId,
            takenOverAt: new Date(takenOverAt),
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversationId))
          .returning();
        return row ? mapConversation(row) : null;
      },
      attachLead: async (conversationId, leadId) => {
        const [row] = await conn
          .update(conversations)
          .set({ leadId, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId))
          .returning();
        return row ? mapConversation(row) : null;
      },
      listConversationsByOrg: (orgId, limit) =>
        conn
          .select({
            c: conversations,
            creatorHandle: creatorProfiles.handle,
            creatorDisplayName: creatorProfiles.displayName,
            audienceEmail: audienceUsers.email,
          })
          .from(conversations)
          .leftJoin(creatorProfiles, eq(creatorProfiles.id, conversations.creatorProfileId))
          .leftJoin(audienceUsers, eq(audienceUsers.id, conversations.audienceUserId))
          .where(eq(conversations.orgId, orgId))
          .orderBy(desc(conversations.updatedAt))
          .limit(limit)
          .then((rows) =>
            rows.map(
              (r): ConversationOperatorView => ({
                ...mapConversation(r.c),
                creatorHandle: r.creatorHandle ?? null,
                creatorDisplayName: r.creatorDisplayName ?? null,
                audienceEmail: r.audienceEmail ?? null,
              }),
            ),
          ),
      listConversationsByAudience: (audienceUserId, limit) =>
        conn
          .select({
            c: conversations,
            creatorHandle: creatorProfiles.handle,
            creatorDisplayName: creatorProfiles.displayName,
          })
          .from(conversations)
          .leftJoin(creatorProfiles, eq(creatorProfiles.id, conversations.creatorProfileId))
          .where(eq(conversations.audienceUserId, audienceUserId))
          .orderBy(desc(conversations.updatedAt))
          .limit(limit)
          .then((rows) =>
            rows.map(
              (r): ConversationAudienceView => ({
                ...mapConversation(r.c),
                creatorHandle: r.creatorHandle ?? null,
                creatorDisplayName: r.creatorDisplayName ?? null,
              }),
            ),
          ),
      insertMessage: (input) =>
        conn
          .insert(messages)
          .values({
            orgId: input.orgId,
            conversationId: input.conversationId,
            authorKind: input.authorKind,
            authorAudienceUserId: input.authorAudienceUserId,
            authorOperatorId: input.authorOperatorId,
            authorAiCreatorId: input.authorAiCreatorId,
            messageType: input.messageType,
            body: input.body,
          })
          .returning()
          .then((r) => mapMessage(r[0]!)),
      findMessageById: (id) => conn.select().from(messages).where(eq(messages.id, id)).limit(1).then((r) => (r[0] ? mapMessage(r[0]) : null)),
      findLatestMessage: (conversationId) =>
        conn
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(1)
          .then((r) => (r[0] ? mapMessage(r[0]) : null)),
      listMessages: (conversationId, limit) =>
        conn
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(asc(messages.createdAt), asc(messages.id))
          .limit(limit)
          .then((rows) => rows.map(mapMessage)),
      insertServiceOffering: (input) =>
        conn
          .insert(serviceOfferings)
          .values({
            orgId: input.orgId,
            aiCreatorId: input.aiCreatorId,
            name: input.name,
            description: input.description,
            category: input.category,
            status: "active",
          })
          .returning()
          .then((r) => mapOffering(r[0]!)),
      findServiceOfferingById: (id) =>
        conn.select().from(serviceOfferings).where(eq(serviceOfferings.id, id)).limit(1).then((r) => (r[0] ? mapOffering(r[0]) : null)),
      listServiceOfferings: (orgId, limit) =>
        conn
          .select()
          .from(serviceOfferings)
          .where(eq(serviceOfferings.orgId, orgId))
          .orderBy(asc(serviceOfferings.name))
          .limit(limit)
          .then((rows) => rows.map(mapOffering)),
      setServiceOfferingStatus: async (id, status) => {
        const [row] = await conn
          .update(serviceOfferings)
          .set({ status, updatedAt: new Date() })
          .where(eq(serviceOfferings.id, id))
          .returning();
        return row ? mapOffering(row) : null;
      },
      insertServiceInquiry: (input) =>
        conn
          .insert(serviceInquiries)
          .values({
            orgId: input.orgId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            classification: input.classification,
            confidence: input.confidence,
            requestedServiceId: input.requestedServiceId,
            status: "open",
          })
          .returning()
          .then((r) => mapInquiry(r[0]!)),
      findServiceInquiryById: (id) =>
        conn.select().from(serviceInquiries).where(eq(serviceInquiries.id, id)).limit(1).then((r) => (r[0] ? mapInquiry(r[0]) : null)),
      findServiceInquiryByMessage: (messageId) =>
        conn.select().from(serviceInquiries).where(eq(serviceInquiries.messageId, messageId)).limit(1).then((r) => (r[0] ? mapInquiry(r[0]) : null)),
      listServiceInquiries: (orgId, limit) =>
        conn
          .select()
          .from(serviceInquiries)
          .where(eq(serviceInquiries.orgId, orgId))
          .orderBy(desc(serviceInquiries.createdAt))
          .limit(limit)
          .then((rows) => rows.map(mapInquiry)),
      setServiceInquiryStatus: async (id, status) => {
        const [row] = await conn
          .update(serviceInquiries)
          .set({ status, updatedAt: new Date() })
          .where(eq(serviceInquiries.id, id))
          .returning();
        return row ? mapInquiry(row) : null;
      },
      insertServiceLead: (input) =>
        conn
          .insert(serviceLeads)
          .values({
            orgId: input.orgId,
            conversationId: input.conversationId,
            creatorProfileId: input.creatorProfileId,
            audienceUserId: input.audienceUserId,
            serviceInquiryId: input.serviceInquiryId,
            classification: input.classification,
            requestedServiceId: input.requestedServiceId,
            status: input.status,
          })
          .returning()
          .then((r) => mapLead(r[0]!)),
      findServiceLeadById: (id) =>
        conn.select().from(serviceLeads).where(eq(serviceLeads.id, id)).limit(1).then((r) => (r[0] ? mapLead(r[0]) : null)),
      listServiceLeads: (orgId, limit) =>
        conn
          .select()
          .from(serviceLeads)
          .where(eq(serviceLeads.orgId, orgId))
          .orderBy(desc(serviceLeads.updatedAt))
          .limit(limit)
          .then((rows) => rows.map(mapLead)),
      setServiceLeadStatus: async (id, status, assignedOperatorId) => {
        const [row] = await conn
          .update(serviceLeads)
          .set({
            status,
            assignedOperatorId: status === "assigned" ? assignedOperatorId : sql`${serviceLeads.assignedOperatorId}`,
            updatedAt: new Date(),
          })
          .where(eq(serviceLeads.id, id))
          .returning();
        return row ? mapLead(row) : null;
      },
      insertLeadFollowUp: (input) =>
        conn
          .insert(leadFollowUps)
          .values({
            orgId: input.orgId,
            leadId: input.leadId,
            operatorId: input.operatorId,
            note: input.note,
          })
          .returning()
          .then((r) => mapFollowUp(r[0]!)),
      listLeadFollowUps: (leadId, limit) =>
        conn
          .select()
          .from(leadFollowUps)
          .where(eq(leadFollowUps.leadId, leadId))
          .orderBy(desc(leadFollowUps.createdAt))
          .limit(limit)
          .then((rows) => rows.map(mapFollowUp)),
      appendAudit,
    };
  };

  // Transaction-scoped creator resolution + org-scoped lookups run on the
  // SAME connection as mutations (no TOCTOU, D2.4-1).
  const findActiveCreatorByHandle = (conn: Database) => async (handle: string) => {
    const [row] = await exec
      .select({
        profileId: creatorProfiles.id,
        orgId: creatorProfiles.orgId,
        aiCreatorId: creatorProfiles.aiCreatorId,
        handle: creatorProfiles.handle,
        displayName: creatorProfiles.displayName,
      })
      .from(creatorProfiles)
      .innerJoin(aiCreators, eq(aiCreators.id, creatorProfiles.aiCreatorId))
      .where(and(eq(creatorProfiles.handle, handle), eq(creatorProfiles.status, "active"), eq(aiCreators.status, "active")))
      .limit(1);
    return row ?? null;
  };

  const findActiveAiCreatorById = (conn: Database) => async (id: string) => {
    const [row] = await exec
      .select({ id: aiCreators.id, orgId: aiCreators.orgId })
      .from(aiCreators)
      .where(and(eq(aiCreators.id, id), eq(aiCreators.status, "active")))
      .limit(1);
    return row ?? null;
  };

  const reads = {
    findActiveCreatorByHandle: findActiveCreatorByHandle(exec),
    findActiveAiCreatorById: findActiveAiCreatorById(exec),
    findConversationById: (id: string) =>
      exec.select().from(conversations).where(eq(conversations.id, id)).limit(1).then((r) => (r[0] ? mapConversation(r[0]) : null)),
    findOpenConversation: (audienceUserId: string, creatorProfileId: string) =>
      exec
        .select()
        .from(conversations)
        .where(and(eq(conversations.audienceUserId, audienceUserId), eq(conversations.creatorProfileId, creatorProfileId), sql`status <> 'closed'`))
        .limit(1)
        .then((rows) => (rows[0] ? mapConversation(rows[0]) : null)),
    listConversationsByOrg: (orgId: string, limit: number) => mutationsFor(exec).listConversationsByOrg(orgId, limit),
    listConversationsByAudience: (audienceUserId: string, limit: number) => mutationsFor(exec).listConversationsByAudience(audienceUserId, limit),
    findMessageById: (id: string) => exec.select().from(messages).where(eq(messages.id, id)).limit(1).then((r) => (r[0] ? mapMessage(r[0]) : null)),
    findLatestMessage: (conversationId: string) => mutationsFor(exec).findLatestMessage(conversationId),
    listMessages: (conversationId: string, limit: number) => mutationsFor(exec).listMessages(conversationId, limit),
    listServiceOfferings: (orgId: string, limit: number) => mutationsFor(exec).listServiceOfferings(orgId, limit),
    findServiceOfferingById: (id: string) => mutationsFor(exec).findServiceOfferingById(id),
    listServiceInquiries: (orgId: string, limit: number) => mutationsFor(exec).listServiceInquiries(orgId, limit),
    findServiceInquiryById: (id: string) => mutationsFor(exec).findServiceInquiryById(id),
    listServiceLeads: (orgId: string, limit: number) => mutationsFor(exec).listServiceLeads(orgId, limit),
    findServiceLeadById: (id: string) => mutationsFor(exec).findServiceLeadById(id),
    listLeadFollowUps: (leadId: string, limit: number) => mutationsFor(exec).listLeadFollowUps(leadId, limit),
    // direct mutations (pool; require audit writer for operator paths)
    insertMessage: (input: Parameters<MessagingTransaction["insertMessage"]>[0]) => mutationsFor(exec).insertMessage(input),
    applyAudienceMessage: (conversationId: string, messageId: string) => mutationsFor(exec).applyAudienceMessage(conversationId, messageId),
    applyOperatorMessage: (conversationId: string, messageId: string) => mutationsFor(exec).applyOperatorMessage(conversationId, messageId),
    setConversationStatus: (id: string, status: ConversationStatus) => mutationsFor(exec).setConversationStatus(id, status),
    applyAudienceReceipt: (conversationId: string, messageId: string) => mutationsFor(exec).applyAudienceReceipt(conversationId, messageId),
    recordTakeover: (conversationId: string, operatorId: string, takenOverAt: string) =>
      mutationsFor(exec).recordTakeover(conversationId, operatorId, takenOverAt),
    attachLead: (conversationId: string, leadId: string) => mutationsFor(exec).attachLead(conversationId, leadId),
    insertServiceOffering: (input: Parameters<MessagingTransaction["insertServiceOffering"]>[0]) => mutationsFor(exec).insertServiceOffering(input),
    setServiceOfferingStatus: (id: string, status: "active" | "retired") => mutationsFor(exec).setServiceOfferingStatus(id, status),
    insertServiceInquiry: (input: Parameters<MessagingTransaction["insertServiceInquiry"]>[0]) => mutationsFor(exec).insertServiceInquiry(input),
    setServiceInquiryStatus: (id: string, status: "open" | "converted" | "dismissed") => mutationsFor(exec).setServiceInquiryStatus(id, status),
    insertServiceLead: (input: Parameters<MessagingTransaction["insertServiceLead"]>[0]) => mutationsFor(exec).insertServiceLead(input),
    setServiceLeadStatus: (id: string, status: LeadStatus, assignedOperatorId: string | null) =>
      mutationsFor(exec).setServiceLeadStatus(id, status, assignedOperatorId),
    insertLeadFollowUp: (input: Parameters<MessagingTransaction["insertLeadFollowUp"]>[0]) => mutationsFor(exec).insertLeadFollowUp(input),
  };

  return {
    ...reads,
    runInTransaction: async <T>(work: (tx: MessagingTransaction) => Promise<T>): Promise<T> =>
      exec.transaction(async (tx) => work(mutationsFor(tx as unknown as Database))),
  } satisfies MessagingRepository;
};
