/**
 * Messaging & Leads domain-service unit tests (Stage 2.17, D2.17-1..D2.17-11).
 *
 * In-memory fake mirroring the REAL repository semantics (status machines,
 * D2.17-7 counter rules, D2.17-8 monotonic receipts, immutable inserts, tx
 * scope + same-tx audit). DB-level enforcement (CHECKs, uniques, RLS, 42501)
 * is proven separately in repository.live.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { ControlCapability } from "@stratifit/permissions";
import {
  createMessagingService,
  createFixedWindowRateLimiter,
  MESSAGING_AUDIT_ACTIONS,
  type ConversationAudienceView,
  type ConversationOperatorView,
  type ConversationRecord,
  type ConversationStatus,
  type LeadFollowUpRecord,
  type LeadStatus,
  type MessagingAuditEntry,
  type MessagingAudiencePrincipal,
  type MessagingOperatorPrincipal,
  type MessagingRepository,
  type MessagingTransaction,
  type MessageRecord,
  type MessageAuthorKind,
  type MessageType,
  type ServiceInquiryRecord,
  type ServiceLeadRecord,
  type ServiceOfferingRecord,
} from "./index";
import type { EventPublisher } from "@stratifit/events";
import type { DomainEventEnvelope } from "@stratifit/contracts";

// ---------------------------------------------------------------------------
// In-memory store + fake repository (same semantics as the Drizzle adapter)
// ---------------------------------------------------------------------------

interface Store {
  conversations: (ConversationRecord & { creatorHandle: string | null; creatorDisplayName: string | null; audienceEmail: string | null })[];
  messages: MessageRecord[];
  offerings: ServiceOfferingRecord[];
  inquiries: ServiceInquiryRecord[];
  leads: ServiceLeadRecord[];
  followUps: LeadFollowUpRecord[];
  creators: { aiCreatorId: string; orgId: string; profileId: string; handle: string; displayName: string; active: boolean }[];
  audit: MessagingAuditEntry[];
  committedAudit: MessagingAuditEntry[];
  /** Commit/emission ordering log (post-commit proof). */
  log: string[];
  /** When set, insertMessage throws inside the transaction (rollback probe). */
  failNextInsert?: boolean;
}

let seq = 0;
let clock = 0;
const uid = (): string => {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
};

// Strictly increasing — receipts/ordering depend on createdAt ordering, as in
// the real database.
const nowIso = (): string => {
  clock += 1;
  return new Date(clock).toISOString();
};

const makeStore = (): Store => ({
  conversations: [],
  messages: [],
  offerings: [],
  inquiries: [],
  leads: [],
  followUps: [],
  creators: [],
  audit: [],
  committedAudit: [],
  log: [],
});

const findConversation = (store: Store, id: string) => store.conversations.find((c) => c.id === id) ?? null;

const txView = (store: Store): MessagingTransaction => ({
  findActiveCreatorByHandle: async (handle) => {
    const c = store.creators.find((r) => r.handle === handle && r.active);
    return c ? { profileId: c.profileId, orgId: c.orgId, aiCreatorId: c.aiCreatorId, handle: c.handle, displayName: c.displayName } : null;
  },
  findActiveAiCreatorById: async (id) => {
    const c = store.creators.find((r) => r.aiCreatorId === id && r.active);
    return c ? { id: c.aiCreatorId, orgId: c.orgId } : null;
  },
  findOpenConversation: async (audienceUserId, creatorProfileId) =>
    store.conversations.find((c) => c.audienceUserId === audienceUserId && c.creatorProfileId === creatorProfileId && c.status !== "closed") ?? null,
  findConversationById: async (id) => findConversation(store, id),
  insertConversation: async (input) => {
    const row = {
      id: uid(),
      orgId: input.orgId,
      creatorProfileId: input.creatorProfileId,
      audienceUserId: input.audienceUserId,
      subject: input.subject,
      status: "open" as ConversationStatus,
      audienceUnreadCount: 0,
      creatorUnreadCount: 0,
      audienceLastReadMessageId: null,
      creatorLastReadMessageId: null,
      leadId: null,
      assignedOperatorId: null,
      takenOverAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      creatorHandle: null,
      creatorDisplayName: null,
      audienceEmail: null,
    };
    store.conversations.push(row);
    return row;
  },
  applyAudienceMessage: async (conversationId, messageId) => {
    const c = findConversation(store, conversationId);
    if (!c) return null;
    const row = { ...c, creatorUnreadCount: c.creatorUnreadCount + 1, audienceLastReadMessageId: messageId, updatedAt: nowIso() };
    store.conversations = store.conversations.map((r) => (r.id === conversationId ? row : r));
    return row;
  },
  applyOperatorMessage: async (conversationId, messageId) => {
    const c = findConversation(store, conversationId);
    if (!c) return null;
    const row = { ...c, audienceUnreadCount: c.audienceUnreadCount + 1, creatorLastReadMessageId: messageId, updatedAt: nowIso() };
    store.conversations = store.conversations.map((r) => (r.id === conversationId ? row : r));
    return row;
  },
  setConversationStatus: async (id, status) => {
    const c = findConversation(store, id);
    if (!c) return null;
    const row = { ...c, status, updatedAt: nowIso() };
    store.conversations = store.conversations.map((r) => (r.id === id ? row : r));
    return row;
  },
  applyAudienceReceipt: async (conversationId, messageId) => {
    const c = findConversation(store, conversationId);
    if (!c) return null;
    const row = { ...c, audienceUnreadCount: 0, audienceLastReadMessageId: messageId, updatedAt: nowIso() };
    store.conversations = store.conversations.map((r) => (r.id === conversationId ? row : r));
    return row;
  },
  recordTakeover: async (conversationId, operatorId, takenOverAt) => {
    const c = findConversation(store, conversationId);
    if (!c) return null;
    const row = { ...c, status: "active" as ConversationStatus, assignedOperatorId: operatorId, takenOverAt, updatedAt: nowIso() };
    store.conversations = store.conversations.map((r) => (r.id === conversationId ? row : r));
    return row;
  },
  attachLead: async (conversationId, leadId) => {
    const c = findConversation(store, conversationId);
    if (!c) return null;
    const row = { ...c, leadId, updatedAt: nowIso() };
    store.conversations = store.conversations.map((r) => (r.id === conversationId ? row : r));
    return row;
  },
  listConversationsByOrg: async (orgId, limit) =>
    store.conversations.filter((c) => c.orgId === orgId).slice(0, limit).map((c) => ({ ...c, creatorHandle: null, creatorDisplayName: null, audienceEmail: null })) as unknown as ConversationOperatorView[],
  listConversationsByAudience: async (audienceUserId, limit) =>
    store.conversations.filter((c) => c.audienceUserId === audienceUserId).slice(0, limit).map((c) => ({ ...c, creatorHandle: null, creatorDisplayName: null })) as unknown as ConversationAudienceView[],
  insertMessage: async (input) => {
    if (store.failNextInsert) {
      store.failNextInsert = false;
      throw new Error("simulated tx failure");
    }
    const row: MessageRecord = {
      id: uid(),
      orgId: input.orgId,
      conversationId: input.conversationId,
      authorKind: input.authorKind as MessageAuthorKind,
      authorAudienceUserId: input.authorAudienceUserId,
      authorOperatorId: input.authorOperatorId,
      authorAiCreatorId: input.authorAiCreatorId,
      messageType: input.messageType as MessageType,
      body: input.body,
      createdAt: nowIso(),
    };
    store.messages.push(row);
    return row;
  },
  findMessageById: async (id) => store.messages.find((m) => m.id === id) ?? null,
  findLatestMessage: async (conversationId) => {
    const rows = store.messages.filter((m) => m.conversationId === conversationId);
    return rows.length ? rows[rows.length - 1]! : null;
  },
  listMessages: async (conversationId, limit) => store.messages.filter((m) => m.conversationId === conversationId).slice(0, limit),
  listServiceOfferings: async (orgId, limit) => store.offerings.filter((o) => o.orgId === orgId).slice(0, limit),
  findServiceOfferingById: async (id) => store.offerings.find((o) => o.id === id) ?? null,
  insertServiceOffering: async (input) => {
    const row: ServiceOfferingRecord = {
      id: uid(),
      orgId: input.orgId,
      aiCreatorId: input.aiCreatorId,
      name: input.name,
      description: input.description,
      category: input.category,
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.offerings.push(row);
    return row;
  },
  setServiceOfferingStatus: async (id, status) => {
    const o = store.offerings.find((r) => r.id === id);
    if (!o) return null;
    const row = { ...o, status, updatedAt: nowIso() };
    store.offerings = store.offerings.map((r) => (r.id === id ? row : r));
    return row;
  },
  listServiceInquiries: async (orgId, limit) => store.inquiries.filter((i) => i.orgId === orgId).slice(0, limit),
  findServiceInquiryById: async (id) => store.inquiries.find((i) => i.id === id) ?? null,
  findServiceInquiryByMessage: async (messageId) => store.inquiries.find((i) => i.messageId === messageId) ?? null,
  insertServiceInquiry: async (input) => {
    const row: ServiceInquiryRecord = {
      id: uid(),
      orgId: input.orgId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      classification: input.classification,
      confidence: input.confidence,
      requestedServiceId: input.requestedServiceId,
      status: "open",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.inquiries.push(row);
    return row;
  },
  setServiceInquiryStatus: async (id, status) => {
    const i = store.inquiries.find((r) => r.id === id);
    if (!i) return null;
    const row = { ...i, status, updatedAt: nowIso() };
    store.inquiries = store.inquiries.map((r) => (r.id === id ? row : r));
    return row;
  },
  listServiceLeads: async (orgId, limit) => store.leads.filter((l) => l.orgId === orgId).slice(0, limit),
  findServiceLeadById: async (id) => store.leads.find((l) => l.id === id) ?? null,
  insertServiceLead: async (input) => {
    const row: ServiceLeadRecord = {
      id: uid(),
      orgId: input.orgId,
      conversationId: input.conversationId,
      creatorProfileId: input.creatorProfileId,
      audienceUserId: input.audienceUserId,
      serviceInquiryId: input.serviceInquiryId,
      classification: input.classification,
      requestedServiceId: input.requestedServiceId,
      status: input.status as LeadStatus,
      assignedOperatorId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.leads.push(row);
    return row;
  },
  setServiceLeadStatus: async (id, status, assignedOperatorId) => {
    const l = store.leads.find((r) => r.id === id);
    if (!l) return null;
    const row = { ...l, status, assignedOperatorId: assignedOperatorId ?? l.assignedOperatorId, updatedAt: nowIso() };
    store.leads = store.leads.map((r) => (r.id === id ? row : r));
    return row;
  },
  listLeadFollowUps: async (leadId, limit) => store.followUps.filter((f) => f.leadId === leadId).slice(0, limit),
  insertLeadFollowUp: async (input) => {
    const row: LeadFollowUpRecord = {
      id: uid(),
      orgId: input.orgId,
      leadId: input.leadId,
      operatorId: input.operatorId,
      note: input.note,
      createdAt: nowIso(),
    };
    store.followUps.push(row);
    return row;
  },
  appendAudit: async (entry) => {
    store.audit.push(entry);
  },
});

const makeRepository = (store: Store): MessagingRepository & { seedCreator: (orgId: string, handle: string, active: boolean) => { aiCreatorId: string; profileId: string } } => {
  const tx = txView(store);
  return {
    ...tx,
    runInTransaction: async <T,>(work: (tx: MessagingTransaction) => Promise<T>) => {
      // Mirror DB atomicity: snapshot the collections; restore them on ANY
      // throw (rollback), so a failed tx leaves nothing behind.
      const snapshot = {
        conversations: [...store.conversations],
        messages: [...store.messages],
        offerings: [...store.offerings],
        inquiries: [...store.inquiries],
        leads: [...store.leads],
        followUps: [...store.followUps],
      };
      const before = store.audit.length;
      try {
        const result = await work(tx);
        store.committedAudit.push(...store.audit.slice(before)); // tx committed
        store.log.push("tx:commit");
        return result;
      } catch (e) {
        store.conversations = snapshot.conversations;
        store.messages = snapshot.messages;
        store.offerings = snapshot.offerings;
        store.inquiries = snapshot.inquiries;
        store.leads = snapshot.leads;
        store.followUps = snapshot.followUps;
        throw e;
      }
    },
    seedCreator: (orgId: string, handle: string, active: boolean) => {
      const aiCreatorId = uid();
      const profileId = uid();
      store.creators.push({ aiCreatorId, orgId, profileId, handle, displayName: `Display ${handle}`, active });
      return { aiCreatorId, profileId };
    },
  };
};

class RecordingPublisher implements EventPublisher {
  readonly events: DomainEventEnvelope[] = [];
  constructor(private readonly log?: string[], private readonly failOn?: string) {}
  async publish(event: DomainEventEnvelope): Promise<void> {
    if (this.failOn && event.name === this.failOn) throw new Error(`simulated publisher failure: ${event.name}`);
    this.events.push(event);
    this.log?.push(`event:${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const ORG_A = uid();
const ORG_B = uid();

const audience = (audienceUserId = uid(), emailVerified = true): MessagingAudiencePrincipal => ({ kind: "audience", audienceUserId, emailVerified });
const operator = (orgId = ORG_A, capabilities: ControlCapability[] = ["messaging.takeover", "lead.assign"]): MessagingOperatorPrincipal => ({
  kind: "operator",
  operatorId: uid(),
  orgId,
  capabilities,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("messaging service — audience sends (D2.17-2/3/7/9)", () => {
  it("creates a conversation + first human message and advances open → awaiting_ai", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher();
    const svc = createMessagingService({ repository: repo, publisher });
    const { profileId } = repo.seedCreator(ORG_A, "nova", true);

    const out = await svc.sendMessage(audience(), { creatorHandle: "nova", body: "Hello!" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.conversationCreated).toBe(true);
    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0]!.status).toBe("awaiting_ai");
    expect(store.conversations[0]!.creatorProfileId).toBe(profileId);
    expect(store.conversations[0]!.orgId).toBe(ORG_A);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]!.authorKind).toBe("human");
    expect(store.messages[0]!.authorOperatorId).toBeNull();
    expect(store.conversations[0]!.creatorUnreadCount).toBe(1);
    const names = publisher.events.map((e) => e.name);
    expect(names).toEqual(["conversation.created", "message.created"]);
  });

  it("reuses the open conversation for a second send (no duplicate conversation.created)", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher();
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();

    const first = await svc.sendMessage(p, { creatorHandle: "nova", body: "one" });
    const second = await svc.sendMessage(p, { creatorHandle: "nova", body: "two" });
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;
    expect(second.value.conversationCreated).toBe(false);
    expect(store.conversations).toHaveLength(1);
    expect(store.messages).toHaveLength(2);
    const names = publisher.events.filter((e) => e.name === "conversation.created").length;
    expect(names).toBe(1);
  });

  it("returns not_found for unknown AND inactive handles (no existence leak)", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const svc = createMessagingService({ repository: repo });
    repo.seedCreator(ORG_A, "ghost", false);

    const unknown = await svc.sendMessage(audience(), { creatorHandle: "nobody-here", body: "hi" });
    const inactive = await svc.sendMessage(audience(), { creatorHandle: "ghost", body: "hi" });
    expect(unknown.ok).toBe(false);
    expect(inactive.ok).toBe(false);
    if (!unknown.ok && !inactive.ok) {
      expect(unknown.error.reason).toBe("not_found");
      expect(inactive.error.reason).toBe("not_found");
    }
    expect(store.conversations).toHaveLength(0);
  });

  it("rejects unverified-email audience sends (fail closed)", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const svc = createMessagingService({ repository: repo });
    repo.seedCreator(ORG_A, "nova", true);
    const out = await svc.sendMessage(audience(uid(), false), { creatorHandle: "nova", body: "hi" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe("unauthorized");
    expect(store.conversations).toHaveLength(0);
  });

  it("validates handle format and body bounds", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const svc = createMessagingService({ repository: repo });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();

    const badHandle = await svc.sendMessage(p, { creatorHandle: "NO", body: "hi" });
    const emptyBody = await svc.sendMessage(p, { creatorHandle: "nova", body: "   " });
    const longBody = await svc.sendMessage(p, { creatorHandle: "nova", body: "x".repeat(4001) });
    expect([badHandle, emptyBody, longBody].every((r) => !r.ok)).toBe(true);
    expect(store.messages).toHaveLength(0);
  });

  it("enforces the D2.17-9 budget: 10 sends per 60s window, keyed by server-derived identity", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const svc = createMessagingService({ repository: repo, rateLimiter: createFixedWindowRateLimiter() });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();

    for (let i = 0; i < 10; i += 1) {
      const out = await svc.sendMessage(p, { creatorHandle: "nova", body: `msg ${i}` });
      expect(out.ok).toBe(true);
    }
    const eleventh = await svc.sendMessage(p, { creatorHandle: "nova", body: "over budget" });
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) expect(eleventh.error.reason).toBe("rate_limited");

    // A different audience user has an independent budget.
    const other = await svc.sendMessage(audience(), { creatorHandle: "nova", body: "different user" });
    expect(other.ok).toBe(true);
  });

  it("shares ONE budget between new conversations and replies (D2.17-9)", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const svc = createMessagingService({ repository: repo, rateLimiter: createFixedWindowRateLimiter() });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();

    await svc.sendMessage(p, { creatorHandle: "nova", body: "first" });
    const conv = store.conversations[0]!.id;
    for (let i = 0; i < 9; i += 1) {
      const out = await svc.replyOwn(p, { conversationId: conv, body: `reply ${i}` });
      expect(out.ok).toBe(true);
    }
    const blocked = await svc.replyOwn(p, { conversationId: conv, body: "over" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.reason).toBe("rate_limited");
  });
});

describe("messaging service — audience threads + receipts (D2.17-8)", () => {
  const seedThread = async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher();
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();
    await svc.sendMessage(p, { creatorHandle: "nova", body: "first" });
    return { store, repo, publisher, svc, p, conversationId: store.conversations[0]!.id };
  };

  it("replyOwn appends a human message to the owner's thread", async () => {
    const t = await seedThread();
    const out = await t.svc.replyOwn(t.p, { conversationId: t.conversationId, body: "reply here" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.authorKind).toBe("human");
      expect(out.value.authorAudienceUserId).toBe(t.p.audienceUserId);
    }
    expect(t.store.messages).toHaveLength(2);
    expect(t.publisher.events.filter((e) => e.name === "message.created")).toHaveLength(2);
  });

  it("audience B cannot read or reply into audience A's thread (owner isolation)", async () => {
    const t = await seedThread();
    const foreign = audience();

    const read = await t.svc.getOwnConversation(foreign, t.conversationId);
    const reply = await t.svc.replyOwn(foreign, { conversationId: t.conversationId, body: "intrusion" });
    const mark = await t.svc.markOwnRead(foreign, { conversationId: t.conversationId });
    expect(read.ok).toBe(false);
    expect(reply.ok).toBe(false);
    expect(mark.ok).toBe(false);
    for (const r of [read, reply, mark]) if (!r.ok) expect(r.error.reason).toBe("not_found");
    expect(t.store.messages).toHaveLength(1);
  });

  it("replyOwn into a closed conversation fails with invalid_status_transition", async () => {
    const t = await seedThread();
    const c = t.store.conversations[0]!;
    t.store.conversations = [{ ...c, status: "closed" }];
    const out = await t.svc.replyOwn(t.p, { conversationId: t.conversationId, body: "hello?" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe("invalid_status_transition");
  });

  it("markOwnRead advances the receipt, resets the audience counter, and emits message.read", async () => {
    const t = await seedThread();
    expect(t.store.conversations[0]!.audienceUnreadCount).toBe(0);

    // Operator reply bumps the audience counter.
    const op = operator(ORG_A);
    await t.svc.reply(op, { conversationId: t.conversationId, body: "operator answer" });
    expect(t.store.conversations[0]!.audienceUnreadCount).toBe(1);

    const read = await t.svc.markOwnRead(t.p, { conversationId: t.conversationId });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.applied).toBe(true);
    expect(t.store.conversations[0]!.audienceUnreadCount).toBe(0);
    expect(t.publisher.events.filter((e) => e.name === "message.read")).toHaveLength(1);
  });

  it("receipts are monotonic advance-only: older target → applied=false, no event, no reset", async () => {
    const t = await seedThread();
    const op = operator(ORG_A);
    const convId = t.conversationId;

    await t.svc.reply(op, { conversationId: convId, body: "one" });
    await t.svc.reply(op, { conversationId: convId, body: "two" });
    const msgs = t.store.messages.filter((m) => m.conversationId === convId);
    const first = msgs[0]!;
    const last = msgs[msgs.length - 1]!;

    const latest = await t.svc.markOwnRead(t.p, { conversationId: convId, messageId: last.id });
    expect(latest.ok && latest.value.applied).toBe(true);

    // Rewinding to the first message must NOT move the receipt backwards.
    const older = await t.svc.markOwnRead(t.p, { conversationId: convId, messageId: first.id });
    expect(older.ok).toBe(true);
    if (older.ok) expect(older.value.applied).toBe(false);
    expect(t.store.conversations[0]!.audienceLastReadMessageId).toBe(last.id);
    expect(t.store.conversations[0]!.audienceUnreadCount).toBe(0);
    expect(t.publisher.events.filter((e) => e.name === "message.read")).toHaveLength(1);
  });

  it("markOwnRead rejects a foreign-conversation message id", async () => {
    const t = await seedThread();
    const otherStore = makeStore();
    const otherRepo = makeRepository(otherStore);
    otherRepo.seedCreator(ORG_B, "orion", true);
    await createMessagingService({ repository: otherRepo }).sendMessage(audience(), { creatorHandle: "orion", body: "elsewhere" });
    const foreignMessageId = otherStore.messages[0]!.id;

    const out = await t.svc.markOwnRead(t.p, { conversationId: t.conversationId, messageId: foreignMessageId });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe("not_found");
  });
});

describe("messaging service — operator conversations (D2.17-3/6)", () => {
  const seedThread = async (status: ConversationStatus = "awaiting_ai") => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher();
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();
    await svc.sendMessage(p, { creatorHandle: "nova", body: "first" });
    if (status !== "awaiting_ai") {
      const c = store.conversations[0]!;
      store.conversations = [{ ...c, status }];
    }
    return { store, repo, publisher, svc, conversationId: store.conversations[0]!.id, seedCount: publisher.events.length };
  };

  it("operator commands require messaging.takeover (reviewer/viewer denied)", async () => {
    const t = await seedThread();
    const weak = operator(ORG_A, ["lead.assign"]);
    const inbox = await t.svc.listInbox(weak, {});
    const get = await t.svc.getConversation(weak, t.conversationId);
    const reply = await t.svc.reply(weak, { conversationId: t.conversationId, body: "x" });
    const takeover = await t.svc.takeover(weak, t.conversationId);
    expect(inbox.ok).toBe(false);
    expect(get.ok).toBe(false);
    expect(reply.ok).toBe(false);
    expect(takeover.ok).toBe(false);
    for (const r of [inbox, get, reply, takeover]) if (!r.ok) expect(r.error.reason).toBe("unauthorized");
  });

  it("cross-org conversation is not_found for the operator (no leak)", async () => {
    const t = await seedThread();
    const foreignOp = operator(ORG_B);
    const get = await t.svc.getConversation(foreignOp, t.conversationId);
    const reply = await t.svc.reply(foreignOp, { conversationId: t.conversationId, body: "x" });
    expect(get.ok).toBe(false);
    expect(reply.ok).toBe(false);
    for (const r of [get, reply]) if (!r.ok) expect(r.error.reason).toBe("not_found");
  });

  it("operator reply to an open conversation is rejected (no audience message yet)", async () => {
    const t = await seedThread("open");
    const out = await t.svc.reply(operator(ORG_A), { conversationId: t.conversationId, body: "x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe("invalid_status_transition");
  });

  it("operator reply to awaiting_ai → active WITHOUT a takeover audit (not a takeover)", async () => {
    const t = await seedThread("awaiting_ai");
    const op = operator(ORG_A);
    const out = await t.svc.reply(op, { conversationId: t.conversationId, body: "answer" });
    expect(out.ok).toBe(true);
    expect(t.store.conversations[0]!.status).toBe("active");
    const actions = t.store.audit.map((a) => a.action);
    expect(actions).toEqual(["messaging.conversation_replied"]);
    const names = t.publisher.events.slice(t.seedCount).map((e) => e.name);
    expect(names).toEqual(["message.created"]);
  });

  it("operator reply to awaiting_human IS the takeover: audit + conversation.taken_over event", async () => {
    const t = await seedThread("awaiting_human");
    const op = operator(ORG_A);
    const out = await t.svc.reply(op, { conversationId: t.conversationId, body: "taking over" });
    expect(out.ok).toBe(true);
    expect(t.store.conversations[0]!.status).toBe("active");
    expect(t.store.conversations[0]!.assignedOperatorId).toBe(op.operatorId);
    expect(t.store.conversations[0]!.takenOverAt).not.toBeNull();
    const actions = t.store.audit.map((a) => a.action);
    expect(actions).toEqual(["messaging.conversation_taken_over", "messaging.conversation_replied"]);
    const names = t.publisher.events.slice(t.seedCount).map((e) => e.name);
    expect(names).toEqual(["conversation.taken_over", "message.created"]);
  });

  it("explicit takeover requires awaiting_human and fails on open/active/closed", async () => {
    for (const status of ["open", "active", "closed"] as ConversationStatus[]) {
      const t = await seedThread(status);
      const out = await t.svc.takeover(operator(ORG_A), t.conversationId);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.reason).toBe("invalid_status_transition");
      expect(t.store.audit).toHaveLength(0);
    }
    const t = await seedThread("awaiting_human");
    const out = await t.svc.takeover(operator(ORG_A), t.conversationId);
    expect(out.ok).toBe(true);
    expect(t.store.conversations[0]!.status).toBe("active");
    expect(t.store.audit.map((a) => a.action)).toEqual(["messaging.conversation_taken_over"]);
    expect(t.publisher.events.slice(t.seedCount).map((e) => e.name)).toEqual(["conversation.taken_over"]);
  });

  it("operator reply to a closed conversation fails closed", async () => {
    const t = await seedThread("closed");
    const out = await t.svc.reply(operator(ORG_A), { conversationId: t.conversationId, body: "x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe("invalid_status_transition");
  });

  it("operator reply bumps the audience unread counter (D2.17-7)", async () => {
    const t = await seedThread("awaiting_ai");
    await t.svc.reply(operator(ORG_A), { conversationId: t.conversationId, body: "answer" });
    expect(t.store.conversations[0]!.audienceUnreadCount).toBe(1);
    expect(t.store.conversations[0]!.creatorLastReadMessageId).not.toBeNull();
  });
});

describe("messaging service — offerings / inquiries / leads (D2.17-1/6)", () => {
  const seedLeadableThread = async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher();
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();
    await svc.sendMessage(p, { creatorHandle: "nova", body: "interested in services" });
    const conversationId = store.conversations[0]!.id;
    const messageId = store.messages[0]!.id;
    return { store, repo, publisher, svc, conversationId, messageId, op: operator(ORG_A) };
  };

  it("createServiceOffering requires lead.assign and an ACTIVE same-org creator", async () => {
    const { svc, repo, store } = await seedLeadableThread();
    const { aiCreatorId } = repo.seedCreator(ORG_A, "other", true);

    const noCap = await svc.createServiceOffering(operator(ORG_A, ["messaging.takeover"]), { aiCreatorId, name: "Starter" });
    expect(noCap.ok).toBe(false);
    if (!noCap.ok) expect(noCap.error.reason).toBe("unauthorized");

    const okOut = await svc.createServiceOffering(operator(ORG_A), { aiCreatorId, name: "Starter" });
    expect(okOut.ok).toBe(true);
    expect(store.offerings).toHaveLength(1);

    const foreignCreator = repo.seedCreator(ORG_B, "foreign", true);
    const cross = await svc.createServiceOffering(operator(ORG_A), { aiCreatorId: foreignCreator.aiCreatorId, name: "X" });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error.reason).toBe("not_found");

    const inactive = repo.seedCreator(ORG_A, "paused", false);
    const inactiveOut = await svc.createServiceOffering(operator(ORG_A), { aiCreatorId: inactive.aiCreatorId, name: "Y" });
    expect(inactiveOut.ok).toBe(false);
    if (!inactiveOut.ok) expect(inactiveOut.error.reason).toBe("not_found");
  });

  it("setServiceOfferingStatus retires/reactivates with an audit row", async () => {
    const { svc, repo, store } = await seedLeadableThread();
    const { aiCreatorId } = repo.seedCreator(ORG_A, "other", true);
    const created = await svc.createServiceOffering(operator(ORG_A), { aiCreatorId, name: "Starter" });
    if (!created.ok) throw new Error("setup failed");
    const offeringId = created.value.id;

    const retire = await svc.setServiceOfferingStatus(operator(ORG_A), { id: offeringId, status: "retired" });
    expect(retire.ok).toBe(true);
    expect(store.offerings[0]!.status).toBe("retired");

    const reactivate = await svc.setServiceOfferingStatus(operator(ORG_A), { id: offeringId, status: "active" });
    expect(reactivate.ok).toBe(true);
    expect(store.offerings[0]!.status).toBe("active");

    const actions = store.audit.filter((a) => a.action.startsWith("messaging.service_")).map((a) => a.action);
    expect(actions).toEqual(["messaging.service_created", "messaging.service_status_changed", "messaging.service_status_changed"]);
  });

  it("classifyInquiry records the operator classification once; duplicate → conflict", async () => {
    const t = await seedLeadableThread();
    const first = await t.svc.classifyInquiry(t.op, {
      conversationId: t.conversationId,
      messageId: t.messageId,
      classification: "commission-request",
    });
    expect(first.ok).toBe(true);
    expect(t.store.inquiries).toHaveLength(1);
    expect(t.store.inquiries[0]!.confidence).toBeNull();

    const dup = await t.svc.classifyInquiry(t.op, {
      conversationId: t.conversationId,
      messageId: t.messageId,
      classification: "again",
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.reason).toBe("conflict");
    expect(t.store.audit.filter((a) => a.action === "messaging.inquiry_classified")).toHaveLength(1);
  });

  it("classifyInquiry rejects a cross-org requestedServiceId (cross_org_reference)", async () => {
    const t = await seedLeadableThread();
    const otherStore = makeStore();
    const otherRepo = makeRepository(otherStore);
    otherRepo.seedCreator(ORG_B, "orion", true);
    const foreignSvc = createMessagingService({ repository: otherRepo });
    const created = await foreignSvc.createServiceOffering(operator(ORG_B), { aiCreatorId: otherStore.creators[0]!.aiCreatorId, name: "Foreign" });
    if (!created.ok) throw new Error("setup failed");

    const out = await t.svc.classifyInquiry(t.op, {
      conversationId: t.conversationId,
      messageId: t.messageId,
      classification: "x",
      requestedServiceId: created.value.id,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.reason).toBe("cross_org_reference");
  });

  it("createLead converts an inquiry: attaches to the conversation, audits, emits lead.created", async () => {
    const t = await seedLeadableThread();
    const inquiry = await t.svc.classifyInquiry(t.op, { conversationId: t.conversationId, messageId: t.messageId, classification: "commission" });
    if (!inquiry.ok) throw new Error("setup failed");

    const lead = await t.svc.createLead(t.op, { conversationId: t.conversationId, serviceInquiryId: inquiry.value.id });
    expect(lead.ok).toBe(true);
    if (lead.ok) {
      expect(lead.value.status).toBe("new");
      expect(lead.value.assignedOperatorId).toBeNull();
    }
    expect(t.store.conversations[0]!.leadId).not.toBeNull();
    expect(t.store.audit.map((a) => a.action)).toContain("messaging.lead_created");
    expect(t.publisher.events.map((e) => e.name)).toContain("lead.created");
  });

  it("createLead enforces ONE lead per conversation and same-conversation inquiry", async () => {
    const t = await seedLeadableThread();
    const inquiry = await t.svc.classifyInquiry(t.op, { conversationId: t.conversationId, messageId: t.messageId, classification: "c" });
    if (!inquiry.ok) throw new Error("setup failed");
    const first = await t.svc.createLead(t.op, { conversationId: t.conversationId, serviceInquiryId: inquiry.value.id });
    expect(first.ok).toBe(true);

    const second = await t.svc.createLead(t.op, { conversationId: t.conversationId, serviceInquiryId: inquiry.value.id });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.reason).toBe("conflict");

    // Inquiry of a DIFFERENT conversation cannot become this conversation's lead.
    // Second thread in the SAME org (fresh audience user) stays lead-less, so
    // the same-conversation check is what fires (not the one-lead guard).
    await t.svc.sendMessage(audience(), { creatorHandle: "nova", body: "second thread" });
    const conv2 = t.store.conversations[1]!.id;
    const mismatch = await t.svc.createLead(t.op, { conversationId: conv2, serviceInquiryId: inquiry.value.id });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.reason).toBe("invalid_input");
  });

  it("assignLead requires triaged status and emits lead.assigned with the assigning operator", async () => {
    const t = await seedLeadableThread();
    const inquiry = await t.svc.classifyInquiry(t.op, { conversationId: t.conversationId, messageId: t.messageId, classification: "c" });
    if (!inquiry.ok) throw new Error("setup failed");
    const lead = await t.svc.createLead(t.op, { conversationId: t.conversationId, serviceInquiryId: inquiry.value.id });
    if (!lead.ok) throw new Error("setup failed");
    const leadId = lead.value.id;

    const early = await t.svc.assignLead(t.op, { leadId });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.reason).toBe("invalid_status_transition");

    const triage = await t.svc.setLeadStatus(t.op, { leadId, status: "triaged" });
    expect(triage.ok).toBe(true);

    const assign = await t.svc.assignLead(t.op, { leadId });
    expect(assign.ok).toBe(true);
    if (assign.ok) expect(assign.value.assignedOperatorId).toBe(t.op.operatorId);
    expect(t.store.audit.filter((a) => a.action === "messaging.lead_assigned")).toHaveLength(1);
    expect(t.publisher.events.filter((e) => e.name === "lead.assigned")).toHaveLength(1);
  });

  it("setLeadStatus follows the frozen linear machine; terminal states are terminal", async () => {
    const t = await seedLeadableThread();
    const inquiry = await t.svc.classifyInquiry(t.op, { conversationId: t.conversationId, messageId: t.messageId, classification: "c" });
    if (!inquiry.ok) throw new Error("setup failed");
    const lead = await t.svc.createLead(t.op, { conversationId: t.conversationId, serviceInquiryId: inquiry.value.id });
    if (!lead.ok) throw new Error("setup failed");
    const leadId = lead.value.id;

    const skip = await t.svc.setLeadStatus(t.op, { leadId, status: "in_progress" });
    expect(skip.ok).toBe(false);

    for (const next of ["triaged", "assigned", "in_progress", "won"] as LeadStatus[]) {
      const out = await t.svc.setLeadStatus(t.op, { leadId, status: next });
      expect(out.ok).toBe(true);
    }
    const terminal = await t.svc.setLeadStatus(t.op, { leadId, status: "lost" });
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error.reason).toBe("invalid_status_transition");
    expect(t.store.audit.filter((a) => a.action === "messaging.lead_status_changed")).toHaveLength(4);
  });

  it("recordFollowUp appends an immutable follow-up and audits; note bounds enforced", async () => {
    const t = await seedLeadableThread();
    const inquiry = await t.svc.classifyInquiry(t.op, { conversationId: t.conversationId, messageId: t.messageId, classification: "c" });
    if (!inquiry.ok) throw new Error("setup failed");
    const lead = await t.svc.createLead(t.op, { conversationId: t.conversationId, serviceInquiryId: inquiry.value.id });
    if (!lead.ok) throw new Error("setup failed");
    const leadId = lead.value.id;

    const followUp = await t.svc.recordFollowUp(t.op, { leadId, note: "called the client" });
    expect(followUp.ok).toBe(true);
    expect(t.store.followUps).toHaveLength(1);
    expect(t.store.audit.filter((a) => a.action === "messaging.follow_up_recorded")).toHaveLength(1);

    const empty = await t.svc.recordFollowUp(t.op, { leadId, note: "  " });
    const huge = await t.svc.recordFollowUp(t.op, { leadId, note: "x".repeat(2001) });
    expect(empty.ok).toBe(false);
    expect(huge.ok).toBe(false);
  });

  it("lead commands require lead.assign; cross-org lead is not_found", async () => {
    const t = await seedLeadableThread();
    const inquiry = await t.svc.classifyInquiry(t.op, { conversationId: t.conversationId, messageId: t.messageId, classification: "c" });
    if (!inquiry.ok) throw new Error("setup failed");
    const lead = await t.svc.createLead(t.op, { conversationId: t.conversationId, serviceInquiryId: inquiry.value.id });
    if (!lead.ok) throw new Error("setup failed");
    const leadId = lead.value.id;

    const noCap = operator(ORG_A, ["messaging.takeover"]);
    const r1 = await t.svc.setLeadStatus(noCap, { leadId, status: "triaged" });
    const r2 = await t.svc.assignLead(noCap, { leadId });
    const r3 = await t.svc.recordFollowUp(noCap, { leadId, note: "x" });
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe("unauthorized");
    }

    const foreign = operator(ORG_B);
    const r4 = await t.svc.getServiceLead(foreign, leadId);
    const r5 = await t.svc.setLeadStatus(foreign, { leadId, status: "triaged" });
    for (const r of [r4, r5]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe("not_found");
    }
  });
});

describe("messaging service — audit + event invariants", () => {
  it("audience mutations carry NO audit rows; operator mutations carry the real operator id", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const svc = createMessagingService({ repository: repo });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();
    await svc.sendMessage(p, { creatorHandle: "nova", body: "hi" });
    await svc.replyOwn(p, { conversationId: store.conversations[0]!.id, body: "again" });
    await svc.markOwnRead(p, { conversationId: store.conversations[0]!.id });
    expect(store.audit).toHaveLength(0);

    const op = operator(ORG_A);
    await svc.reply(op, { conversationId: store.conversations[0]!.id, body: "op answer" });
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]!.actorId).toBe(op.operatorId);
    expect(store.audit[0]!.organizationId).toBe(ORG_A);
  });

  it("emits exactly the frozen event names — no social.*, no notification events", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher();
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();
    await svc.sendMessage(p, { creatorHandle: "nova", body: "hi" });
    const op = operator(ORG_A);
    await svc.reply(op, { conversationId: store.conversations[0]!.id, body: "reply" });
    await svc.markOwnRead(p, { conversationId: store.conversations[0]!.id });
    const names = new Set(publisher.events.map((e) => e.name));
    for (const name of names) {
      expect(["conversation.created", "message.created", "message.read", "conversation.taken_over", "lead.created", "lead.assigned"]).toContain(name);
    }
  });

  it("MESSAGING_AUDIT_ACTIONS is exactly the frozen nine", () => {
    expect([...MESSAGING_AUDIT_ACTIONS]).toEqual([
      "messaging.conversation_taken_over",
      "messaging.conversation_replied",
      "messaging.inquiry_classified",
      "messaging.lead_created",
      "messaging.lead_assigned",
      "messaging.lead_status_changed",
      "messaging.follow_up_recorded",
      "messaging.service_created",
      "messaging.service_status_changed",
    ]);
  });

  it("post-commit emission: tx commits BEFORE any event is emitted (commit → event)", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher(store.log);
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);
    const out = await svc.sendMessage(audience(), { creatorHandle: "nova", body: "ordering proof" });
    expect(out.ok).toBe(true);
    // COMMIT strictly precedes every emission.
    expect(store.log).toEqual(["tx:commit", "event:conversation.created", "event:message.created"]);
  });

  it("tx failure → NO event emitted and mutation rolled back (fake mirrors the DB)", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher(store.log);
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);
    store.failNextInsert = true;

    await expect(svc.sendMessage(audience(), { creatorHandle: "nova", body: "doomed" })).rejects.toThrow("simulated tx failure");
    expect(store.log).toEqual([]);
    expect(store.conversations).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
    expect(publisher.events).toHaveLength(0);
  });

  it("publisher failure AFTER commit does not roll back the committed mutation", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher(store.log, "conversation.created");
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);

    // The mutation is durable; the throwing handler propagates but the tx
    // already committed (store.log holds tx:commit before the failing emit).
    await expect(svc.sendMessage(audience(), { creatorHandle: "nova", body: "durable" })).rejects.toThrow("simulated publisher failure");
    expect(store.log).toEqual(["tx:commit"]);
    expect(store.conversations).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]!.body).toBe("durable");
  });

  it("emission ordering preserves exact event names and counts for a full thread lifecycle", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const publisher = new RecordingPublisher(store.log);
    const svc = createMessagingService({ repository: repo, publisher });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();
    const sent = await svc.sendMessage(p, { creatorHandle: "nova", body: "first" });
    if (!sent.ok) throw new Error("setup failed");
    const op = operator(ORG_A);
    await svc.reply(op, { conversationId: sent.value.conversationId, body: "answer" });
    await svc.markOwnRead(p, { conversationId: sent.value.conversationId });

    const eventLog = store.log.filter((l) => l.startsWith("event:")).map((l) => l.slice("event:".length));
    expect(eventLog).toEqual([
      "conversation.created",
      "message.created",
      "message.created",
      "message.read",
    ]);
    // Every emission happened after its transaction committed: each tx:commit
    // precedes the events of the SAME command; no event precedes ANY commit.
    expect(store.log.indexOf("event:conversation.created")).toBeGreaterThan(store.log.indexOf("tx:commit"));
  });

  it("mutating a message body after insert is impossible through the service surface (no update path exists)", async () => {
    const store = makeStore();
    const repo = makeRepository(store);
    const svc = createMessagingService({ repository: repo });
    repo.seedCreator(ORG_A, "nova", true);
    const p = audience();
    await svc.sendMessage(p, { creatorHandle: "nova", body: "original" });
    // The repository port deliberately exposes NO message-update/delete method;
    // the only way "body" could change is direct store surgery (live tests
    // prove the DB denies UPDATE with 42501).
    expect("updateMessage" in repo).toBe(false);
    expect("deleteMessage" in repo).toBe(false);
    expect(store.messages[0]!.body).toBe("original");
  });
});
