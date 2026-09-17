import { handleIssueManifest } from "@/lib/production-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/productions/[id]/manifest — issue a new immutable
 * manifest version for an approved production (production.approve). The
 * manifest reuses the existing ProductionManifest contract; issuance is
 * audited in the same transaction (D2.4-1).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleIssueManifest(request, id);
}
