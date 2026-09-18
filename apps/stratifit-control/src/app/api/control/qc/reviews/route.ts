import { handleRequestQcReview } from "@/lib/qc-commands";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/qc/reviews — request a QC review (production.approve).
 * Thin adapter: authentication, capability checks, validation, and the
 * section 13 error envelope live in lib/qc-commands. Duplicate requests
 * dedupe deterministically to the existing review (200 vs 201).
 */
export async function POST(request: Request) {
  return handleRequestQcReview(request);
}
