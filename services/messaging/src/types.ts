/**
 * Messaging & Leads domain service types (Stage 2.17, D2.17-1..D2.17-11).
 *
 * services/messaging owns bounded context 14 (DM sections 23-24):
 * conversations + immutable messages, service_offerings (authorized naming
 * deviation — public.services is occupied by a pre-existing foreign
 * marketing/CRM schema on the shared Supabase project; see DOMAIN_MODEL §38),
 * service_inquiries, service_leads, and the immutable lead_follow_ups family.
 *
 * HARD BOUNDARIES (frozen):
 *  - D2.17-2: the AI Communication Engine is DEFERRED — no LLM adapter, no AI
 *    worker. `awaiting_ai` is a valid state that no AI enters in 2.17; the
 *    future engine only consumes message.created and issues reply commands.
 *  - D2.17-3: the FULL DM §32.7 conversation machine is enforced; no invented
 *    edges; `closed` is terminal (D2.17-11: awaiting_human/closed are
 *    structurally valid but unreachable until the engine exists).
 *  - D2.17-7: unread counters are denormalized and reset-to-zero on receipt —
 *    there is NO decrement path anywhere.
 *  - D2.17-8: read receipts are mutable columns on the MUTABLE conversations
 *    aggregate; messages stay a pure immutable family (INSERT+SELECT).
 *  - Audience sends/receipts carry NO audit rows; the nine operator audit
 *    actions are same-transaction (D2.4-1 seam reused from People).
 *  - People integration ONLY through the narrow findActiveCreatorByHandle
 *    seam (active creator + active profile; handle is a lookup key, never
 *    authority).
 *  - org_id ALWAYS derives server-side: the creator profile's org (Media
 *    path) or the operator's membership (Control path) — never a client field.
 */
import type { ControlCapability } from "@stratifit/permissions";
import type { EventPublisher } from "@stratifit/events";

// ---------------------------------------------------------------------------
// Machines (DB CHECK mirrors)
// ---------------------------------------------------------------------------

export const CONVERSATION_STATUSES = ["open", "awaiting_ai", "active", "awaiting_human", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_AUTHOR_KINDS = ["ai", "human", "system"] as const;
export type MessageAuthorKind = (typeof MESSAGE_AUTHOR_KINDS)[number];

export const MESSAGE_TYPES = ["message", "service_inquiry", "system_notice"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const LEAD_STATUSES = ["new", "triaged", "assigned", "in_progress", "won", "lost", "archived"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Body length mirror of the DB CHECK (MessageRequest contract: 1..4000). */
export const MESSAGE_BODY_MAX = 4000;

/** Participant kinds for read receipts (DM §23: exactly two fixed participants). */
export const PARTICIPANT_KINDS = ["audience_user", "creator_profile"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

/**
 * FROZEN transition table (DM §32.7, D2.17-3). No self-edges; `closed` is
 * terminal. 2.17 mapping: audience first message open→awaiting_ai (same tx);
 * operator reply awaiting_ai→active and awaiting_human→active (the takeover);
 * explicit takeover command awaiting_human→active.
 */
export const CONVERSATION_TRANSITIONS: Readonly<Record<ConversationStatus, readonly ConversationStatus[]>> = {
  open: ["awaiting_ai"],
  awaiting_ai: ["active"],
  active: ["awaiting_human", "awaiting_ai"],
  awaiting_human: ["closed", "active"],
  closed: [],
};

export const validConversationTransition = (from: ConversationStatus, to: ConversationStatus): boolean =>
  CONVERSATION_TRANSITIONS[from].includes(to);

/**
 * FROZEN lead machine (DM §32.9): strict linear new → triaged → assigned →
 * in_progress → won | lost | archived. Terminal: won/lost/archived.
 * `assigned` additionally requires an assigned operator (service rule).
 */
export const LEAD_TRANSITIONS: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  new: ["triaged"],
  triaged: ["assigned"],
  assigned: ["in_progress"],
  in_progress: ["won", "lost", "archived"],
  won: [],
  lost: [],
  archived: [],
};

export const validLeadTransition = (from: LeadStatus, to: LeadStatus): boolean =>
  LEAD_TRANSITIONS[from].includes(to);

// ---------------------------------------------------------------------------
// Records (service-internal; never cross the API unwrapped)
// ---------------------------------------------------------------------------

export interface ConversationRecord {
  readonly id: string;
  readonly orgId: string;
  readonly creatorProfileId: string;
  readonly audienceUserId: string;
  readonly subject: string | null;
  readonly status: ConversationStatus;
  readonly audienceUnreadCount: number;
  readonly creatorUnreadCount: number;
  readonly audienceLastReadMessageId: string | null;
  readonly creatorLastReadMessageId: string | null;
  readonly leadId: string | null;
  readonly assignedOperatorId: string | null;
  readonly takenOverAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessageRecord {
  readonly id: string;
  readonly orgId: string;
  readonly conversationId: string;
  readonly authorKind: MessageAuthorKind;
  readonly authorAudienceUserId: string | null;
  readonly authorOperatorId: string | null;
  readonly authorAiCreatorId: string | null;
  readonly messageType: MessageType;
  readonly body: string;
  readonly createdAt: string;
}

export interface ServiceOfferingRecord {
  readonly id: string;
  readonly orgId: string;
  readonly aiCreatorId: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly status: "active" | "retired";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceInquiryRecord {
  readonly id: string;
  readonly orgId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly classification: string;
  readonly confidence: string | null;
  readonly requestedServiceId: string | null;
  readonly status: "open" | "converted" | "dismissed";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceLeadRecord {
  readonly id: string;
  readonly orgId: string;
  readonly conversationId: string;
  readonly creatorProfileId: string;
  readonly audienceUserId: string;
  readonly serviceInquiryId: string;
  readonly classification: string | null;
  readonly requestedServiceId: string | null;
  readonly status: LeadStatus;
  readonly assignedOperatorId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LeadFollowUpRecord {
  readonly id: string;
  readonly orgId: string;
  readonly leadId: string;
  readonly operatorId: string;
  readonly note: string;
  readonly createdAt: string;
}

/** Inbox/thread join views (operator-private / audience-private). */
export interface ConversationOperatorView extends ConversationRecord {
  readonly creatorHandle: string | null;
  readonly creatorDisplayName: string | null;
  readonly audienceEmail: string | null;
}

export interface ConversationAudienceView extends ConversationRecord {
  readonly creatorHandle: string | null;
  readonly creatorDisplayName: string | null;
}

// ---------------------------------------------------------------------------
// Princpals (authority ALWAYS server-derived)
// ---------------------------------------------------------------------------

export interface MessagingOperatorPrincipal {
  readonly kind: "operator";
  readonly operatorId: string;
  readonly orgId: string;
  readonly capabilities: readonly ControlCapability[];
}

export interface MessagingAudiencePrincipal {
  readonly kind: "audience";
  readonly audienceUserId: string;
  readonly emailVerified: boolean;
}

export type MessagingPrincipal = MessagingOperatorPrincipal | MessagingAudiencePrincipal;

// ---------------------------------------------------------------------------
// Command results (house style: discriminated, never throws)
// ---------------------------------------------------------------------------

export type MessagingErrorReason =
  | "unauthorized"
  | "not_found"
  | "cross_org_reference"
  | "inactive_parent"
  | "invalid_status_transition"
  | "invalid_input"
  | "conflict"
  | "rate_limited";

export type MessagingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly reason: MessagingErrorReason; readonly message: string } };

export const ok = <T>(value: T): MessagingResult<T> => ({ ok: true, value });
export const err = <T>(reason: MessagingErrorReason, message: string): MessagingResult<T> => ({
  ok: false,
  error: { reason, message },
});

// ---------------------------------------------------------------------------
// Rate limiting (D2.17-9: in-process fixed window behind an injected port)
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** Returns false when the caller exceeded the window budget. */
  consume(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Same-transaction audit (D2.4-1 seam reused from People)
// ---------------------------------------------------------------------------

export interface MessagingAuditEntry {
  readonly action: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata?: Record<string, unknown>;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
}

export interface MessagingAuditWriter {
  appendWithin(tx: unknown, entry: MessagingAuditEntry): Promise<void>;
}

/** FROZEN audit actions (Stage 2.17 build authorization §9): exactly these nine. */
export const MESSAGING_AUDIT_ACTIONS = [
  "messaging.conversation_taken_over",
  "messaging.conversation_replied",
  "messaging.inquiry_classified",
  "messaging.lead_created",
  "messaging.lead_assigned",
  "messaging.lead_status_changed",
  "messaging.follow_up_recorded",
  "messaging.service_created",
  "messaging.service_status_changed",
] as const;

// ---------------------------------------------------------------------------
// Repository port (Drizzle adapter in repository.ts)
// ---------------------------------------------------------------------------

export interface MessagingTransaction {
  // creator resolution (narrow People seam — read-only)
  findActiveCreatorByHandle(
    handle: string,
  ): Promise<{
    readonly profileId: string;
    readonly orgId: string;
    readonly aiCreatorId: string;
    readonly handle: string;
    readonly displayName: string;
  } | null>;
  /** ACTIVE AI creator by id (same-org validation for offerings). */
  findActiveAiCreatorById(
    id: string,
  ): Promise<{ readonly id: string; readonly orgId: string } | null>;

  // conversations
  findOpenConversation(audienceUserId: string, creatorProfileId: string): Promise<ConversationRecord | null>;
  findConversationById(id: string): Promise<ConversationRecord | null>;
  insertConversation(input: {
    orgId: string;
    creatorProfileId: string;
    audienceUserId: string;
    subject: string | null;
  }): Promise<ConversationRecord>;
  /** Audience message side effects (D2.17-7): creator counter +1, author receipt advances. */
  applyAudienceMessage(conversationId: string, messageId: string): Promise<ConversationRecord | null>;
  /** Operator message side effects: audience counter +1, operator receipt advances. */
  applyOperatorMessage(conversationId: string, messageId: string): Promise<ConversationRecord | null>;
  setConversationStatus(id: string, status: ConversationStatus): Promise<ConversationRecord | null>;
  /** D2.17-8 receipt (audience side): monotonic advance + counter reset-to-zero. */
  applyAudienceReceipt(conversationId: string, messageId: string): Promise<ConversationRecord | null>;
  /** Takeover: status → active + assignment record. */
  recordTakeover(conversationId: string, operatorId: string, takenOverAt: string): Promise<ConversationRecord | null>;
  /** One lead per conversation (service-enforced); nullable until created. */
  attachLead(conversationId: string, leadId: string): Promise<ConversationRecord | null>;
  listConversationsByOrg(orgId: string, limit: number): Promise<readonly ConversationOperatorView[]>;
  listConversationsByAudience(audienceUserId: string, limit: number): Promise<readonly ConversationAudienceView[]>;

  // messages (IMMUTABLE: insert + read only)
  insertMessage(input: {
    orgId: string;
    conversationId: string;
    authorKind: MessageAuthorKind;
    authorAudienceUserId: string | null;
    authorOperatorId: string | null;
    authorAiCreatorId: string | null;
    messageType: MessageType;
    body: string;
  }): Promise<MessageRecord>;
  findMessageById(id: string): Promise<MessageRecord | null>;
  findLatestMessage(conversationId: string): Promise<MessageRecord | null>;
  listMessages(conversationId: string, limit: number): Promise<readonly MessageRecord[]>;

  // service offerings
  insertServiceOffering(input: {
    orgId: string;
    aiCreatorId: string;
    name: string;
    description: string | null;
    category: string | null;
  }): Promise<ServiceOfferingRecord>;
  findServiceOfferingById(id: string): Promise<ServiceOfferingRecord | null>;
  listServiceOfferings(orgId: string, limit: number): Promise<readonly ServiceOfferingRecord[]>;
  setServiceOfferingStatus(id: string, status: "active" | "retired"): Promise<ServiceOfferingRecord | null>;

  // service inquiries
  insertServiceInquiry(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    classification: string;
    confidence: string | null;
    requestedServiceId: string | null;
  }): Promise<ServiceInquiryRecord>;
  findServiceInquiryById(id: string): Promise<ServiceInquiryRecord | null>;
  findServiceInquiryByMessage(messageId: string): Promise<ServiceInquiryRecord | null>;
  listServiceInquiries(orgId: string, limit: number): Promise<readonly ServiceInquiryRecord[]>;
  setServiceInquiryStatus(id: string, status: "open" | "converted" | "dismissed"): Promise<ServiceInquiryRecord | null>;

  // service leads
  insertServiceLead(input: {
    orgId: string;
    conversationId: string;
    creatorProfileId: string;
    audienceUserId: string;
    serviceInquiryId: string;
    classification: string | null;
    requestedServiceId: string | null;
    status: LeadStatus;
  }): Promise<ServiceLeadRecord>;
  findServiceLeadById(id: string): Promise<ServiceLeadRecord | null>;
  listServiceLeads(orgId: string, limit: number): Promise<readonly ServiceLeadRecord[]>;
  setServiceLeadStatus(id: string, status: LeadStatus, assignedOperatorId: string | null): Promise<ServiceLeadRecord | null>;

  // lead follow-ups (IMMUTABLE: insert + read only)
  insertLeadFollowUp(input: { orgId: string; leadId: string; operatorId: string; note: string }): Promise<LeadFollowUpRecord>;
  listLeadFollowUps(leadId: string, limit: number): Promise<readonly LeadFollowUpRecord[]>;

  /**
   * D2.4-1 seam: same-transaction audit writer. Implementations MUST NOT
   * commit or roll back inside `appendAudit` — transaction ownership stays
   * with `runInTransaction`.
   */
  appendAudit(entry: MessagingAuditEntry): Promise<void>;
}

export interface MessagingRepository {
  /**
   * D2.4-1 (reused): run `work` inside ONE database transaction whose scoped
   * view is `MessagingTransaction`, so an operator mutation can never commit
   * without its audit record. Optional; audited mutations require it.
   */
  runInTransaction?<T>(work: (tx: MessagingTransaction) => Promise<T>): Promise<T>;
  // read-only paths (pool connection; no audit needed)
  findActiveCreatorByHandle(
    handle: string,
  ): Promise<{
    readonly profileId: string;
    readonly orgId: string;
    readonly aiCreatorId: string;
    readonly handle: string;
    readonly displayName: string;
  } | null>;
  findActiveAiCreatorById(
    id: string,
  ): Promise<{ readonly id: string; readonly orgId: string } | null>;
  findConversationById(id: string): Promise<ConversationRecord | null>;
  findOpenConversation(audienceUserId: string, creatorProfileId: string): Promise<ConversationRecord | null>;
  listConversationsByOrg(orgId: string, limit: number): Promise<readonly ConversationOperatorView[]>;
  listConversationsByAudience(audienceUserId: string, limit: number): Promise<readonly ConversationAudienceView[]>;
  findMessageById(id: string): Promise<MessageRecord | null>;
  findLatestMessage(conversationId: string): Promise<MessageRecord | null>;
  listMessages(conversationId: string, limit: number): Promise<readonly MessageRecord[]>;
  listServiceOfferings(orgId: string, limit: number): Promise<readonly ServiceOfferingRecord[]>;
  findServiceOfferingById(id: string): Promise<ServiceOfferingRecord | null>;
  listServiceInquiries(orgId: string, limit: number): Promise<readonly ServiceInquiryRecord[]>;
  findServiceInquiryById(id: string): Promise<ServiceInquiryRecord | null>;
  listServiceLeads(orgId: string, limit: number): Promise<readonly ServiceLeadRecord[]>;
  findServiceLeadById(id: string): Promise<ServiceLeadRecord | null>;
  listLeadFollowUps(leadId: string, limit: number): Promise<readonly LeadFollowUpRecord[]>;
  // mutation paths (pool; require audit writer like People's adapter)
  insertMessage(input: Parameters<MessagingTransaction["insertMessage"]>[0]): Promise<MessageRecord>;
  applyAudienceMessage(conversationId: string, messageId: string): Promise<ConversationRecord | null>;
  applyOperatorMessage(conversationId: string, messageId: string): Promise<ConversationRecord | null>;
  setConversationStatus(id: string, status: ConversationStatus): Promise<ConversationRecord | null>;
  applyAudienceReceipt(conversationId: string, messageId: string): Promise<ConversationRecord | null>;
  recordTakeover(conversationId: string, operatorId: string, takenOverAt: string): Promise<ConversationRecord | null>;
  attachLead(conversationId: string, leadId: string): Promise<ConversationRecord | null>;
  insertServiceOffering(input: Parameters<MessagingTransaction["insertServiceOffering"]>[0]): Promise<ServiceOfferingRecord>;
  setServiceOfferingStatus(id: string, status: "active" | "retired"): Promise<ServiceOfferingRecord | null>;
  insertServiceInquiry(input: Parameters<MessagingTransaction["insertServiceInquiry"]>[0]): Promise<ServiceInquiryRecord>;
  setServiceInquiryStatus(id: string, status: "open" | "converted" | "dismissed"): Promise<ServiceInquiryRecord | null>;
  insertServiceLead(input: Parameters<MessagingTransaction["insertServiceLead"]>[0]): Promise<ServiceLeadRecord>;
  setServiceLeadStatus(id: string, status: LeadStatus, assignedOperatorId: string | null): Promise<ServiceLeadRecord | null>;
  insertLeadFollowUp(input: Parameters<MessagingTransaction["insertLeadFollowUp"]>[0]): Promise<LeadFollowUpRecord>;
}

// ---------------------------------------------------------------------------
// Service port
// ---------------------------------------------------------------------------

export interface MessagingServiceDeps {
  readonly repository: MessagingRepository;
  /** D2.4-1 seam: same-transaction audit writer (composition-root mapped). */
  readonly auditWriter?: MessagingAuditWriter;
  /** Post-commit event emission; defaults to a no-handler in-process publisher. */
  readonly publisher?: EventPublisher;
  readonly eventIdFactory?: () => string;
  /** D2.17-9: audience send limiter (in-process fixed window default). */
  readonly rateLimiter?: RateLimiter;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

export interface SendMessageOutcome {
  readonly conversationId: string;
  readonly messageId: string;
  /** True when this send CREATED the conversation (open → awaiting_ai in one tx). */
  readonly conversationCreated: boolean;
}

export interface MessagingService {
  // ---- audience commands (email-verified; rate-limited where noted) ------
  sendMessage(
    principal: MessagingAudiencePrincipal,
    input: { readonly creatorHandle: string; readonly body: string; readonly subject?: string },
  ): Promise<MessagingResult<SendMessageOutcome>>;
  listOwnConversations(
    principal: MessagingAudiencePrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ConversationAudienceView[]>>;
  getOwnConversation(
    principal: MessagingAudiencePrincipal,
    conversationId: string,
  ): Promise<MessagingResult<{ readonly conversation: ConversationAudienceView; readonly messages: readonly MessageRecord[] }>>;
  replyOwn(
    principal: MessagingAudiencePrincipal,
    input: { readonly conversationId: string; readonly body: string },
  ): Promise<MessagingResult<MessageRecord>>;
  markOwnRead(
    principal: MessagingAudiencePrincipal,
    input: { readonly conversationId: string; readonly messageId?: string },
  ): Promise<MessagingResult<{ readonly applied: boolean }>>;

  // ---- operator commands (capability-gated) ------------------------------
  listInbox(
    principal: MessagingOperatorPrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ConversationOperatorView[]>>;
  getConversation(
    principal: MessagingOperatorPrincipal,
    conversationId: string,
  ): Promise<MessagingResult<{ readonly conversation: ConversationOperatorView; readonly messages: readonly MessageRecord[] }>>;
  reply(
    principal: MessagingOperatorPrincipal,
    input: { readonly conversationId: string; readonly body: string },
  ): Promise<MessagingResult<MessageRecord>>;
  takeover(
    principal: MessagingOperatorPrincipal,
    conversationId: string,
  ): Promise<MessagingResult<ConversationRecord>>;

  // ---- offerings / inquiries / leads (lead.assign) -----------------------
  createServiceOffering(
    principal: MessagingOperatorPrincipal,
    input: { readonly aiCreatorId: string; readonly name: string; readonly description?: string; readonly category?: string },
  ): Promise<MessagingResult<ServiceOfferingRecord>>;
  listServiceOfferings(
    principal: MessagingOperatorPrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ServiceOfferingRecord[]>>;
  setServiceOfferingStatus(
    principal: MessagingOperatorPrincipal,
    input: { readonly id: string; readonly status: "active" | "retired" },
  ): Promise<MessagingResult<ServiceOfferingRecord>>;
  listServiceInquiries(
    principal: MessagingOperatorPrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ServiceInquiryRecord[]>>;
  classifyInquiry(
    principal: MessagingOperatorPrincipal,
    input: {
      readonly conversationId: string;
      readonly messageId: string;
      readonly classification: string;
      readonly requestedServiceId?: string | null;
    },
  ): Promise<MessagingResult<ServiceInquiryRecord>>;
  dismissInquiry?(
    principal: MessagingOperatorPrincipal,
    input: { readonly id: string },
  ): Promise<MessagingResult<ServiceInquiryRecord>>;
  createLead(
    principal: MessagingOperatorPrincipal,
    input: { readonly conversationId: string; readonly serviceInquiryId: string },
  ): Promise<MessagingResult<ServiceLeadRecord>>;
  listServiceLeads(
    principal: MessagingOperatorPrincipal,
    input: { readonly limit?: number },
  ): Promise<MessagingResult<readonly ServiceLeadRecord[]>>;
  getServiceLead(
    principal: MessagingOperatorPrincipal,
    leadId: string,
  ): Promise<MessagingResult<{ readonly lead: ServiceLeadRecord; readonly followUps: readonly LeadFollowUpRecord[] }>>;
  assignLead(
    principal: MessagingOperatorPrincipal,
    input: { readonly leadId: string; readonly operatorId?: string | null },
  ): Promise<MessagingResult<ServiceLeadRecord>>;
  setLeadStatus(
    principal: MessagingOperatorPrincipal,
    input: { readonly leadId: string; readonly status: LeadStatus },
  ): Promise<MessagingResult<ServiceLeadRecord>>;
  recordFollowUp(
    principal: MessagingOperatorPrincipal,
    input: { readonly leadId: string; readonly note: string },
  ): Promise<MessagingResult<LeadFollowUpRecord>>;
}
