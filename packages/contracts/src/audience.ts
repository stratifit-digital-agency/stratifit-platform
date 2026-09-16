import { z } from "zod";

/**
 * Audience-facing social contracts.
 *
 * Public users are audience users, not producers. These schemas model the
 * public-safe shapes only: identity claims, social actions, and the message
 * request surface. Authentication and authorization are enforced server-side
 * by Media BFF routes; these contracts never grant capability.
 */

export const AudienceIdentity = z.object({
  /** Supabase user ID once auth is wired; opaque string until then. */
  userId: z.string().min(1),
  email: z.string().email(),
  /** Server-derived claim: email verified before commenting/sharing/messaging. */
  emailVerified: z.boolean(),
});

export type AudienceIdentity = z.infer<typeof AudienceIdentity>;

export const SocialAction = z.enum(["like", "comment", "share", "save", "follow", "message"]);
export type SocialAction = z.infer<typeof SocialAction>;

/** Actions requiring server-verified email before they may execute. */
export const EMAIL_VERIFIED_ACTIONS: readonly SocialAction[] = [
  "comment",
  "share",
  "message",
] as const;

export const requiresEmailVerification = (action: SocialAction): boolean =>
  EMAIL_VERIFIED_ACTIONS.includes(action);

export const MessageRequest = z.object({
  creatorHandle: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "lowercase letters, digits, dashes"),
  body: z.string().min(1).max(4000),
});

export type MessageRequest = z.infer<typeof MessageRequest>;

/**
 * Message authorship kinds. The system must distinguish AI-generated
 * responses, human responses, and system messages.
 */
export const MessageAuthorKind = z.enum(["ai", "human", "system"]);
export type MessageAuthorKind = z.infer<typeof MessageAuthorKind>;
