import { handlePublishingPublish } from "@/lib/publishing-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/publications/[id]/publish — scheduled → publishing →
 * published | failed (production.publish). Valid ONLY from `scheduled`;
 * publishing from `approved` is forbidden (approved leaves ONLY via
 * schedule). A failed delivery never invalidates the underlying master
 * asset/production.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handlePublishingPublish(request, id);
}
