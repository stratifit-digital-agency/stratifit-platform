/**
 * Messaging & Leads domain service (Stage 2.17, D2.17-1..D2.17-11).
 *
 * Every command:
 *  - derives ALL authority from the server-side principal (audienceUserId or
 *    operator org/capabilities — never a client body field);
 *  - audience sends/receipts are email-verified (authorizeAudienceAction is
 *    additionally enforced at the Media BFF; this service re-checks
 *    fail-closed) and carry NO audit rows;
 *  - operator mutations run INSIDE one transaction with their audit record
 *    (D2.4-1 seam) — rollback removes both;
 *  - events are emitted POST-COMMIT on the injected publisher (no outbox, no
 *    workers) and handlers stay idempotent by eventId;
 *  - conversation status changes ONLY through the frozen DM §32.7 transition
 *    table (D2.17-3); lead status ONLY through the frozen DM §32.9 table;
 *  - unread counters follow D2.17-7 (increment on the OTHER participant's
 *    message, reset-to-zero on receipt — no decrement path exists);
 *  - read receipts follow D2.17-8 (mutable columns on the conversation
 *    aggregate; monotonic advance-only; no event when nothing changed).
 */
import { randomUUID } from "node:crypto";
import { emitEvent, InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  ConversationAudienceView,
  ConversationOperatorView,
  ConversationRecord,
  ConversationStatus,
  LeadFollowUpRecord,
  LeadStatus,
  MessagingAuditEntry,
  MessagingAudiencePrincipal,
  MessagingOperatorPrincipal,
  MessagingRepository,
  MessagingResult,
  MessagingService,
  MessagingServiceDeps,
  MessagingTransaction,
  MessageRecord,
  MessageAuthorKind,
  ServiceInquiryRecord,
  ServiceLeadRecord,
  ServiceOfferingRecord,
  SendMessageOutcome,
} from "./types";
import {
  err,
  MESSAGE_BODY_MAX,
  ok,
  validConversationTransition,
  validLeadTransition,
} from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[a-z0-9-]{3,64}$/;
const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? 50, 1), 200);

const requireUuid = (value: string): boolean => UUID_RE.test(value);

const bodyOk = (body: string): boolean => typeof body === "string" && body.trim().length >= 1 && body.length <= MESSAGE_BODY_MAX;

const inTx = async <T>(repo: MessagingRepository, work: (tx: MessagingTransaction) => Promise<T>): Promise<T> => {
  if (repo.runInTransaction) return repo.runInTransaction(work);
  throw new Error("messaging repository does not support transactions; audited mutations require runInTransaction (D2.4-1)");
};

export const createMessagingService = (deps: MessagingServiceDeps): MessagingService => {
  const repo = deps.repository;
  const publisher: EventPublisher = deps.publisher ?? new InProcessEventPublisher([]);
  const nextEventId = deps.eventIdFactory ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const limiter = deps.rateLimiter; // undefined = no limiter wired (documented tests-only posture)

  const emit = async (
    name: "conversation.created" | "message.created" | "message.read" | "conversation.taken_over" | "lead.created" | "lead.assigned",
    payload: Record<string, unknown>,
    correlation: { organizationId: string; conversationId?: string },
  ) => {
    await emitEvent(publisher, {
      eventId: nextEventId(),
      name,
      correlation: { organizationId: correlation.organizationId, conversationId: correlation.conversationId },
      payload,
    });
  };

  const audit = async (tx: MessagingTransaction, entry: MessagingAuditEntry) => {
    await tx.appendAudit(entry);
  };

  // Post-commit event emission (Publishing-Engine house pattern): the
  // transaction body COLLECTS pending events; inTxWithEvents emits them ONLY
  // after inTx resolves (COMMIT). A rollback never reaches the emit loop — a
  // failed transaction emits NOTHING. An emission failure after commit cannot
  // roll the mutation back (it is already durable). No outbox/queue/worker is
  // introduced (Stage 2.17 scope).
  type PendingEvent = readonly [
    name: Parameters<typeof emit>[0],
    payload: Record<string, unknown>,
    correlation: Parameters<typeof emit>[2],
  ];
  const inTxWithEvents = async <T>(
    work: (tx: MessagingTransaction, events: PendingEvent[]) => Promise<T>,
  ): Promise<T> => {
    const pending: PendingEvent[] = [];
    const value = await inTx(repo, (tx) => work(tx, pending));
    // POST-COMMIT ONLY (mutation → COMMIT → emission).
    for (const [name, payload, correlation] of pending) {
      await emit(name, payload, correlation);
    }
    return value;
  };

  const operatorGate = (principal: MessagingOperatorPrincipal, capability: "messaging.takeover" | "lead.assign"): MessagingResult<void> =>
    principal.capabilities.includes(capability) ? ok(undefined) : err("unauthorized", `${capability} capability required`);

  const audienceGate = (principal: MessagingAudiencePrincipal): MessagingResult<void> =>
    principal.emailVerified ? ok(undefined) : err("unauthorized", "email verification required before messaging");

  const conversationForOperator = async (
    tx: MessagingTransaction,
    principal: MessagingOperatorPrincipal,
    conversationId: string,
  ): Promise<MessagingResult<ConversationRecord>> => {
    if (!requireUuid(conversationId)) return err("invalid_input", "conversation id must be a uuid");
    const conv = await tx.findConversationById(conversationId);
    // Fail closed with not_found for BOTH missing and cross-org — no leak.
    if (!conv || conv.orgId !== principal.orgId) return err("not_found", "conversation not found");
    return ok(conv);
  };

  const conversationForAudience = async (
    tx: MessagingTransaction,
    principal: MessagingAudiencePrincipal,
    conversationId: string,
  ): Promise<MessagingResult<ConversationRecord>> => {
    if (!requireUuid(conversationId)) return err("invalid_input", "conversation id must be a uuid");
    const conv = await tx.findConversationById(conversationId);
    // Fail closed with not_found for BOTH missing and foreign-owner — no leak.
    if (!conv || conv.audienceUserId !== principal.audienceUserId) return err("not_found", "conversation not found");
    return ok(conv);
  };

  // -------------------------------------------------------------------------
  // Audience commands
  // -------------------------------------------------------------------------

  const sendMessage = async (
    principal: MessagingAudiencePrincipal,
    input: { readonly creatorHandle: string; readonly body: string; readonly subject?: string },
  ): Promise<MessagingResult<SendMessageOutcome>> => {
    const gate = audienceGate(principal);
    if (!gate.ok) return gate;
    if (typeof input.creatorHandle !== "string" || !HANDLE_RE.test(input.creatorHandle)) {
      return err("invalid_input", "creator handle is invalid");
    }
    if (!bodyOk(input.body)) return err("invalid_input", `body must be 1..${MESSAGE_BODY_MAX} characters`);
    if (input.subject !== undefined && (typeof input.subject !== "string" || input.subject.length > 200)) {
      return err("invalid_input", "subject must be at most 200 characters");
    }
    // D2.17-9: new conversations and replies share one budget, keyed by the
    // SERVER-DERIVED audience user id (client identifiers cannot influence it).
    if (limiter && !(await limiter.consume(principal.audienceUserId))) {
      return err("rate_limited", "too many messages; retry later");
    }
    // Narrow People seam: active creator + active profile by handle. Unknown
    // or inactive → not_found with NO existence leak.
    const creator = await repo.findActiveCreatorByHandle(input.creatorHandle);
    if (!creator) return err("not_found", "creator not found");

    return inTxWithEvents(async (tx, events) => {
      const existing = await tx.findOpenConversation(principal.audienceUserId, creator.profileId);
      if (existing && existing.status === "open") {
        // Only reachable in the atomic-create window; treated as fresh send.
      }
      let conversation = existing;
      const conversationCreated = !conversation;
      if (!conversation) {
        conversation = await tx.insertConversation({
          orgId: creator.orgId,
          creatorProfileId: creator.profileId,
          audienceUserId: principal.audienceUserId,
          subject: input.subject ?? null,
        });
      } else if (conversation.status === "closed") {
        return err("invalid_status_transition", "conversation is closed");
      }
      const message = await tx.insertMessage({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        authorKind: "human",
        authorAudienceUserId: principal.audienceUserId,
        authorOperatorId: null,
        authorAiCreatorId: null,
        messageType: "message",
        body: input.body,
      });
      conversation = (await tx.applyAudienceMessage(conversation.id, message.id)) ?? conversation;
      if (conversationCreated) {
        // Audience first message: open → awaiting_ai (frozen D2.17-3 mapping).
        conversation = (await tx.setConversationStatus(conversation.id, "awaiting_ai")) ?? conversation;
      }
      const orgId = conversation.orgId;
      const conversationId = conversation.id;
      const created = conversationCreated;
      const messageId = message.id;
      // Pending events — emitted POST-COMMIT by inTxWithEvents.
      if (created) {
        events.push(["conversation.created", { conversationId, audienceUserId: principal.audienceUserId, creatorProfileId: conversation.creatorProfileId }, { organizationId: orgId, conversationId }]);
      }
      events.push(["message.created", { conversationId, messageId, authorKind: "human", messageType: "message" }, { organizationId: orgId, conversationId }]);
      return ok({ conversationId, messageId, conversationCreated: created });
    });
  };

  const replyOwn = async (
    principal: MessagingAudiencePrincipal,
    input: { readonly conversationId: string; readonly body: string },
  ): Promise<MessagingResult<MessageRecord>> => {
    const gate = audienceGate(principal);
    if (!gate.ok) return gate;
    if (!bodyOk(input.body)) return err("invalid_input", `body must be 1..${MESSAGE_BODY_MAX} characters`);
    if (limiter && !(await limiter.consume(principal.audienceUserId))) {
      return err("rate_limited", "too many messages; retry later");
    }
    return inTxWithEvents(async (tx, events) => {
      const conv = await conversationForAudience(tx, principal, input.conversationId);
      if (!conv.ok) return conv;
      if (conv.value.status === "closed") return err("invalid_status_transition", "conversation is closed");
      const message = await tx.insertMessage({
        orgId: conv.value.orgId,
        conversationId: conv.value.id,
        authorKind: "human",
        authorAudienceUserId: principal.audienceUserId,
        authorOperatorId: null,
        authorAiCreatorId: null,
        messageType: "message",
        body: input.body,
      });
      await tx.applyAudienceMessage(conv.value.id, message.id);
      const orgId = conv.value.orgId;
      const conversationId = conv.value.id;
      events.push(["message.created", { conversationId, messageId: message.id, authorKind: "human", messageType: "message" }, { organizationId: orgId, conversationId }]);
      return ok(message);
    });
  };

  const markOwnRead = async (
    principal: MessagingAudiencePrincipal,
    input: { readonly conversationId: string; readonly messageId?: string },
  ): Promise<MessagingResult<{ readonly applied: boolean }>> => {
    const gate = audienceGate(principal);
    if (!gate.ok) return gate;
    return inTxWithEvents(async (tx, events) => {
      const conv = await conversationForAudience(tx, principal, input.conversationId);
      if (!conv.ok) return conv;
      const target = input.messageId
        ? await tx.findMessageById(input.messageId)
        : await tx.findLatestMessage(conv.value.id);
      if (!target || target.conversationId !== conv.value.id) return err("not_found", "message not found");
      // Monotonic advance-only (D2.17-8): a receipt never moves backwards.
      if (conv.value.audienceLastReadMessageId) {
        const current = await tx.findMessageById(conv.value.audienceLastReadMessageId);
        if (current && Date.parse(target.createdAt) <= Date.parse(current.createdAt)) {
          return ok({ applied: false });
        }
      }
      await tx.applyAudienceReceipt(conv.value.id, target.id);
      const orgId = conv.value.orgId;
      const conversationId = conv.value.id;
      events.push(["message.read", { conversationId, participantKind: "audience_user" }, { organizationId: orgId, conversationId }]);
      return ok({ applied: true });
    });
  };

  const listOwnConversations = async (
    principal: MessagingAudiencePrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ConversationAudienceView[]>> =>
    ok(await repo.listConversationsByAudience(principal.audienceUserId, clampLimit(input?.limit)));

  const getOwnConversation = async (
    principal: MessagingAudiencePrincipal,
    conversationId: string,
  ): Promise<MessagingResult<{ readonly conversation: ConversationAudienceView; readonly messages: readonly MessageRecord[] }>> => {
    if (!requireUuid(conversationId)) return err("invalid_input", "conversation id must be a uuid");
    const conv = await repo.findConversationById(conversationId);
    if (!conv || conv.audienceUserId !== principal.audienceUserId) return err("not_found", "conversation not found");
    const views = await repo.listConversationsByAudience(principal.audienceUserId, 200);
    const view = views.find((v) => v.id === conversationId);
    const messages = await repo.listMessages(conversationId, 500);
    return ok({
      conversation: view ?? { ...conv, creatorHandle: null, creatorDisplayName: null },
      messages,
    });
  };

  // -------------------------------------------------------------------------
  // Operator commands — conversations (messaging.takeover)
  // -------------------------------------------------------------------------

  const listInbox = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ConversationOperatorView[]>> => {
    const gate = operatorGate(principal, "messaging.takeover");
    if (!gate.ok) return gate;
    return ok(await repo.listConversationsByOrg(principal.orgId, clampLimit(input?.limit)));
  };

  const getConversation = async (
    principal: MessagingOperatorPrincipal,
    conversationId: string,
  ): Promise<MessagingResult<{ readonly conversation: ConversationOperatorView; readonly messages: readonly MessageRecord[] }>> => {
    const gate = operatorGate(principal, "messaging.takeover");
    if (!gate.ok) return gate;
    if (!requireUuid(conversationId)) return err("invalid_input", "conversation id must be a uuid");
    const conv = await repo.findConversationById(conversationId);
    if (!conv || conv.orgId !== principal.orgId) return err("not_found", "conversation not found");
    const views = await repo.listConversationsByOrg(principal.orgId, 200);
    const view = views.find((v) => v.id === conversationId);
    const messages = await repo.listMessages(conversationId, 500);
    return ok({
      conversation: view ?? { ...conv, creatorHandle: null, creatorDisplayName: null, audienceEmail: null },
      messages,
    });
  };

  const reply = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly conversationId: string; readonly body: string },
  ): Promise<MessagingResult<MessageRecord>> => {
    const gate = operatorGate(principal, "messaging.takeover");
    if (!gate.ok) return gate;
    if (!bodyOk(input.body)) return err("invalid_input", `body must be 1..${MESSAGE_BODY_MAX} characters`);
    return inTxWithEvents(async (tx, events) => {
      const conv = await conversationForOperator(tx, principal, input.conversationId);
      if (!conv.ok) return conv;
      if (conv.value.status === "closed") return err("invalid_status_transition", "conversation is closed");
      if (conv.value.status === "open") return err("invalid_status_transition", "conversation has no audience message yet");
      const message = await tx.insertMessage({
        orgId: conv.value.orgId,
        conversationId: conv.value.id,
        authorKind: "human",
        authorAudienceUserId: null,
        authorOperatorId: principal.operatorId,
        authorAiCreatorId: null,
        messageType: "message",
        body: input.body,
      });
      await tx.applyOperatorMessage(conv.value.id, message.id);
      let tookOver = false;
      if (conv.value.status === "awaiting_ai") {
        await tx.setConversationStatus(conv.value.id, "active");
      } else if (conv.value.status === "awaiting_human") {
        // Operator reply to an AI-escalated thread IS the takeover (DM §32.7).
        await tx.recordTakeover(conv.value.id, principal.operatorId, now().toISOString());
        await audit(tx, {
          action: "messaging.conversation_taken_over",
          organizationId: principal.orgId,
          actorId: principal.operatorId,
          targetType: "conversation",
          targetId: conv.value.id,
          metadata: { via: "operator_reply" },
          correlationId: null,
          causationId: message.id,
        });
        tookOver = true;
      }
      await audit(tx, {
        action: "messaging.conversation_replied",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "conversation",
        targetId: conv.value.id,
        metadata: { messageId: message.id },
        correlationId: null,
        causationId: message.id,
      });
      const orgId = conv.value.orgId;
      const conversationId = conv.value.id;
      if (tookOver) {
        events.push(["conversation.taken_over", { conversationId, operatorId: principal.operatorId, takenOverAt: now().toISOString() }, { organizationId: orgId, conversationId }]);
      }
      events.push(["message.created", { conversationId, messageId: message.id, authorKind: "human", messageType: "message" }, { organizationId: orgId, conversationId }]);
      return ok(message);
    });
  };

  const takeover = async (
    principal: MessagingOperatorPrincipal,
    conversationId: string,
  ): Promise<MessagingResult<ConversationRecord>> => {
    const gate = operatorGate(principal, "messaging.takeover");
    if (!gate.ok) return gate;
    return inTxWithEvents(async (tx, events) => {
      const conv = await conversationForOperator(tx, principal, conversationId);
      if (!conv.ok) return conv;
      if (!validConversationTransition(conv.value.status, "active")) {
        return err("invalid_status_transition", `takeover requires awaiting_human (current: ${conv.value.status})`);
      }
      const updated = await tx.recordTakeover(conv.value.id, principal.operatorId, now().toISOString());
      await audit(tx, {
        action: "messaging.conversation_taken_over",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "conversation",
        targetId: conv.value.id,
        metadata: {},
        correlationId: null,
        causationId: null,
      });
      const orgId = conv.value.orgId;
      events.push(["conversation.taken_over", { conversationId: conv.value.id, operatorId: principal.operatorId, takenOverAt: now().toISOString() }, { organizationId: orgId, conversationId: conv.value.id }]);
      return ok(updated ?? conv.value);
    });
  };

  // -------------------------------------------------------------------------
  // Operator commands — offerings / inquiries / leads (lead.assign)
  // -------------------------------------------------------------------------

  const createServiceOffering = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly aiCreatorId: string; readonly name: string; readonly description?: string; readonly category?: string },
  ): Promise<MessagingResult<ServiceOfferingRecord>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    if (!requireUuid(input.aiCreatorId)) return err("invalid_input", "ai creator id must be a uuid");
    if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > 200) {
      return err("invalid_input", "name must be 1..200 characters");
    }
    return inTx(repo, async (tx) => {
      const creator = await tx.findActiveAiCreatorById(input.aiCreatorId);
      if (!creator || creator.orgId !== principal.orgId) return err("not_found", "ai creator not found");
      const offering = await tx.insertServiceOffering({
        orgId: principal.orgId,
        aiCreatorId: input.aiCreatorId,
        name: input.name,
        description: input.description ?? null,
        category: input.category ?? null,
      });
      await audit(tx, {
        action: "messaging.service_created",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "service_offering",
        targetId: offering.id,
        metadata: { name: offering.name },
        correlationId: null,
        causationId: null,
      });
      return ok(offering);
    });
  };

  const listServiceOfferings = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ServiceOfferingRecord[]>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    return ok(await repo.listServiceOfferings(principal.orgId, clampLimit(input?.limit)));
  };

  const setServiceOfferingStatus = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly id: string; readonly status: "active" | "retired" },
  ): Promise<MessagingResult<ServiceOfferingRecord>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    if (!requireUuid(input.id)) return err("invalid_input", "offering id must be a uuid");
    return inTx(repo, async (tx) => {
      const offering = await tx.findServiceOfferingById(input.id);
      if (!offering || offering.orgId !== principal.orgId) return err("not_found", "service offering not found");
      const updated = await tx.setServiceOfferingStatus(input.id, input.status);
      await audit(tx, {
        action: "messaging.service_status_changed",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "service_offering",
        targetId: input.id,
        metadata: { from: offering.status, to: input.status },
        correlationId: null,
        causationId: null,
      });
      return ok(updated ?? offering);
    });
  };

  const listServiceInquiries = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ServiceInquiryRecord[]>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    return ok(await repo.listServiceInquiries(principal.orgId, clampLimit(input?.limit)));
  };

  const classifyInquiry = async (
    principal: MessagingOperatorPrincipal,
    input: {
      readonly conversationId: string;
      readonly messageId: string;
      readonly classification: string;
      readonly requestedServiceId?: string | null;
    },
  ): Promise<MessagingResult<ServiceInquiryRecord>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    if (!requireUuid(input.conversationId) || !requireUuid(input.messageId)) {
      return err("invalid_input", "conversation and message ids must be uuids");
    }
    if (typeof input.classification !== "string" || input.classification.trim().length < 1 || input.classification.length > 200) {
      return err("invalid_input", "classification must be 1..200 characters");
    }
    return inTx(repo, async (tx) => {
      const conv = await conversationForOperator(tx, principal, input.conversationId);
      if (!conv.ok) return conv;
      const message = await tx.findMessageById(input.messageId);
      if (!message || message.conversationId !== conv.value.id) return err("not_found", "message not found");
      const existing = await tx.findServiceInquiryByMessage(input.messageId);
      if (existing) return err("conflict", "message already classified");
      if (input.requestedServiceId) {
        if (!requireUuid(input.requestedServiceId)) return err("invalid_input", "requested service id must be a uuid");
        const offering = await tx.findServiceOfferingById(input.requestedServiceId);
        if (!offering || offering.orgId !== principal.orgId) return err("cross_org_reference", "requested service belongs to a different organization");
      }
      const inquiry = await tx.insertServiceInquiry({
        orgId: principal.orgId,
        conversationId: conv.value.id,
        messageId: input.messageId,
        classification: input.classification,
        confidence: null, // 2.17: operator classification; AI confidence is future
        requestedServiceId: input.requestedServiceId ?? null,
      });
      await audit(tx, {
        action: "messaging.inquiry_classified",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "service_inquiry",
        targetId: inquiry.id,
        metadata: { classification: inquiry.classification, messageId: input.messageId },
        correlationId: null,
        causationId: input.messageId,
      });
      return ok(inquiry);
    });
  };

  const createLead = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly conversationId: string; readonly serviceInquiryId: string },
  ): Promise<MessagingResult<ServiceLeadRecord>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    if (!requireUuid(input.conversationId) || !requireUuid(input.serviceInquiryId)) {
      return err("invalid_input", "conversation and inquiry ids must be uuids");
    }
    return inTxWithEvents(async (tx, events) => {
      const conv = await conversationForOperator(tx, principal, input.conversationId);
      if (!conv.ok) return conv;
      if (conv.value.leadId) return err("conflict", "conversation already has a lead");
      const inquiry = await tx.findServiceInquiryById(input.serviceInquiryId);
      if (!inquiry || inquiry.orgId !== principal.orgId) return err("not_found", "service inquiry not found");
      if (inquiry.conversationId !== conv.value.id) return err("invalid_input", "inquiry belongs to a different conversation");
      const lead = await tx.insertServiceLead({
        orgId: principal.orgId,
        conversationId: conv.value.id,
        creatorProfileId: conv.value.creatorProfileId,
        audienceUserId: conv.value.audienceUserId,
        serviceInquiryId: inquiry.id,
        classification: inquiry.classification,
        requestedServiceId: inquiry.requestedServiceId,
        status: "new",
      });
      await tx.attachLead(conv.value.id, lead.id);
      await audit(tx, {
        action: "messaging.lead_created",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "service_lead",
        targetId: lead.id,
        metadata: { conversationId: conv.value.id, serviceInquiryId: inquiry.id },
        correlationId: null,
        causationId: null,
      });
      const orgId = principal.orgId;
      const leadId = lead.id;
      events.push(["lead.created", { leadId, conversationId: conv.value.id, serviceInquiryId: inquiry.id }, { organizationId: orgId, conversationId: conv.value.id }]);
      return ok(lead);
    });
  };

  const listServiceLeads = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ServiceLeadRecord[]>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    return ok(await repo.listServiceLeads(principal.orgId, clampLimit(input?.limit)));
  };

  const getServiceLead = async (
    principal: MessagingOperatorPrincipal,
    leadId: string,
  ): Promise<MessagingResult<{ readonly lead: ServiceLeadRecord; readonly followUps: readonly LeadFollowUpRecord[] }>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    if (!requireUuid(leadId)) return err("invalid_input", "lead id must be a uuid");
    const lead = await repo.findServiceLeadById(leadId);
    if (!lead || lead.orgId !== principal.orgId) return err("not_found", "lead not found");
    const followUps = await repo.listLeadFollowUps(leadId, 200);
    return ok({ lead, followUps });
  };

  const assignLead = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly leadId: string; readonly operatorId?: string | null },
  ): Promise<MessagingResult<ServiceLeadRecord>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    if (!requireUuid(input.leadId)) return err("invalid_input", "lead id must be a uuid");
    if (input.operatorId && input.operatorId !== principal.operatorId) {
      // 2.17 assignment records the ASSIGNING operator; cross-operator
      // reassignment is not part of the frozen surface.
      return err("invalid_input", "assignment records the assigning operator");
    }
    return inTxWithEvents(async (tx, events) => {
      const lead = await tx.findServiceLeadById(input.leadId);
      if (!lead || lead.orgId !== principal.orgId) return err("not_found", "lead not found");
      if (!validLeadTransition(lead.status, "assigned")) {
        return err("invalid_status_transition", `assignment requires triaged (current: ${lead.status})`);
      }
      const updated = await tx.setServiceLeadStatus(input.leadId, "assigned", principal.operatorId);
      await audit(tx, {
        action: "messaging.lead_assigned",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "service_lead",
        targetId: input.leadId,
        metadata: { assignedOperatorId: principal.operatorId },
        correlationId: null,
        causationId: null,
      });
      events.push(["lead.assigned", { leadId: input.leadId, operatorId: principal.operatorId }, { organizationId: principal.orgId }]);
      return ok(updated ?? lead);
    });
  };

  const setLeadStatus = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly leadId: string; readonly status: LeadStatus },
  ): Promise<MessagingResult<ServiceLeadRecord>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    if (!requireUuid(input.leadId)) return err("invalid_input", "lead id must be a uuid");
    return inTx(repo, async (tx) => {
      const lead = await tx.findServiceLeadById(input.leadId);
      if (!lead || lead.orgId !== principal.orgId) return err("not_found", "lead not found");
      if (!validLeadTransition(lead.status, input.status)) {
        return err("invalid_status_transition", `invalid lead transition ${lead.status} → ${input.status}`);
      }
      const updated = await tx.setServiceLeadStatus(input.leadId, input.status, lead.assignedOperatorId);
      await audit(tx, {
        action: "messaging.lead_status_changed",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "service_lead",
        targetId: input.leadId,
        metadata: { from: lead.status, to: input.status },
        correlationId: null,
        causationId: null,
      });
      return ok(updated ?? lead);
    });
  };

  const recordFollowUp = async (
    principal: MessagingOperatorPrincipal,
    input: { readonly leadId: string; readonly note: string },
  ): Promise<MessagingResult<LeadFollowUpRecord>> => {
    const gate = operatorGate(principal, "lead.assign");
    if (!gate.ok) return gate;
    if (!requireUuid(input.leadId)) return err("invalid_input", "lead id must be a uuid");
    if (typeof input.note !== "string" || input.note.trim().length < 1 || input.note.length > 2000) {
      return err("invalid_input", "note must be 1..2000 characters");
    }
    return inTx(repo, async (tx) => {
      const lead = await tx.findServiceLeadById(input.leadId);
      if (!lead || lead.orgId !== principal.orgId) return err("not_found", "lead not found");
      const followUp = await tx.insertLeadFollowUp({
        orgId: principal.orgId,
        leadId: input.leadId,
        operatorId: principal.operatorId,
        note: input.note,
      });
      await audit(tx, {
        action: "messaging.follow_up_recorded",
        organizationId: principal.orgId,
        actorId: principal.operatorId,
        targetType: "service_lead",
        targetId: input.leadId,
        metadata: { followUpId: followUp.id },
        correlationId: null,
        causationId: null,
      });
      return ok(followUp);
    });
  };

  return {
    sendMessage,
    listOwnConversations,
    getOwnConversation,
    replyOwn,
    markOwnRead,
    listInbox,
    getConversation,
    reply,
    takeover,
    createServiceOffering,
    listServiceOfferings,
    setServiceOfferingStatus,
    listServiceInquiries,
    classifyInquiry,
    createLead,
    listServiceLeads,
    getServiceLead,
    assignLead,
    setLeadStatus,
    recordFollowUp,
  };
};
