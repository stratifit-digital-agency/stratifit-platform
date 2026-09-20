import { handleListInbox } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/conversations
 *   GET — org-scoped conversation inbox (messaging.takeover; D2.17-6).
 */
export async function GET(request: Request) {
  return handleListInbox(request);
}
