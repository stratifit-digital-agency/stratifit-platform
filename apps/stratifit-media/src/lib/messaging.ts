import { authorizeAudienceAction, type AudienceIdentity } from "@stratifit/auth";
import { MessageRequest } from "@stratifit/contracts";

/**
 * Server-side message handling for AI-profile messaging.
 *
 * Flow: Viewer → AI Profile → Message → email verification → Conversation UI.
 * The email-verification requirement is enforced HERE, server-side, via the
 * pure rule in @stratifit/auth. The browser never decides authorization.
 *
 * Conversation persistence, the AI Communication Engine, and the Control Room
 * inbox arrive in a later phase behind this same entry point.
 */

export type StartConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; reason: "not_authenticated" | "email_verification_required" | "invalid_request" };

export const startConversation = (
  identity: AudienceIdentity | null,
  rawInput: unknown,
): StartConversationResult => {
  const decision = authorizeAudienceAction(identity, "message");
  if (!decision.allowed) return { ok: false, reason: decision.reason };

  const parsed = MessageRequest.safeParse(rawInput);
  if (!parsed.success) return { ok: false, reason: "invalid_request" };

  // Placeholder conversation identity; durable conversations arrive later.
  return { ok: true, conversationId: `conv-${Date.now()}` };
};
