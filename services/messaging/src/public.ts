/**
 * Owner-safe / operator-safe projections (Stage 2.17). The ONLY shapes the
 * Media BFF and Control Room receive. Audience-private views never expose
 * org ids, operator identities, lead/assignment/takeover internals, or audit
 * data; conversation/message ids appear only as opaque owner-scoped addressing
 * references (D2.13-4 precedent) and never on any public surface.
 *
 * The Control Room view is operator-internal (org-scoped): it may include the
 * viewer email and assignment facts — those are operator-private data
 * (DATA_FLOW §5), never audience-visible.
 */
import type {
  ConversationAudienceView,
  ConversationOperatorView,
  ConversationRecord,
  MessageRecord,
} from "./types";

/** Audience-safe thread view (owner-scoped). */
export interface AudienceConversationView {
  readonly conversationId: string;
  readonly status: string;
  readonly subject: string | null;
  readonly creatorHandle: string | null;
  readonly creatorDisplayName: string | null;
  readonly audienceUnreadCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AudienceMessageView {
  readonly id: string;
  readonly authorKind: string;
  readonly body: string;
  readonly messageType: string;
  readonly createdAt: string;
}

/** Operator-safe thread view (org-scoped; includes assignment + viewer email). */
export interface OperatorConversationView {
  readonly conversationId: string;
  readonly status: string;
  readonly subject: string | null;
  readonly creatorHandle: string | null;
  readonly creatorDisplayName: string | null;
  readonly audienceEmail: string | null;
  readonly audienceUnreadCount: number;
  readonly creatorUnreadCount: number;
  readonly assignedOperatorId: string | null;
  readonly takenOverAt: string | null;
  readonly leadId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const toAudienceConversationView = (c: ConversationAudienceView): AudienceConversationView => ({
  conversationId: c.id,
  status: c.status,
  subject: c.subject,
  creatorHandle: c.creatorHandle,
  creatorDisplayName: c.creatorDisplayName,
  audienceUnreadCount: c.audienceUnreadCount,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

export const toOperatorConversationView = (c: ConversationOperatorView): OperatorConversationView => ({
  conversationId: c.id,
  status: c.status,
  subject: c.subject,
  creatorHandle: c.creatorHandle,
  creatorDisplayName: c.creatorDisplayName,
  audienceEmail: c.audienceEmail,
  audienceUnreadCount: c.audienceUnreadCount,
  creatorUnreadCount: c.creatorUnreadCount,
  assignedOperatorId: c.assignedOperatorId,
  takenOverAt: c.takenOverAt,
  leadId: c.leadId,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

export const toAudienceMessageView = (m: MessageRecord): AudienceMessageView => ({
  id: m.id,
  authorKind: m.authorKind,
  body: m.body,
  messageType: m.messageType,
  createdAt: m.createdAt,
});

export const conversationExists = (c: ConversationRecord | null): boolean => c !== null;
