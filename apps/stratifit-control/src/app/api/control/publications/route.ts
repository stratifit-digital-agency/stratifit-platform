import { handleCreatePublication } from "@/lib/publishing-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/publications — create a publication (201) or
 * deterministically deduplicate (200) on (org, subject, platform).
 * Capability: production.publish. The actor and organization are always
 * server-derived; no client org_id exists in the schema.
 */
export async function POST(request: Request) {
  return handleCreatePublication(request);
}
