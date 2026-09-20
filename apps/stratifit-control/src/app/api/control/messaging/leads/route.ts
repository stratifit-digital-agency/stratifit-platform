import { handleCreateLead, handleListServiceLeads } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/leads (service_leads table — see DOMAIN_MODEL §38
 * note on the shared-database naming deviation)
 *   GET  — list the org's leads (lead.assign)
 *   POST — create a lead from a classified inquiry (lead.assign; one lead per
 *          conversation)
 */
export async function GET(request: Request) {
  return handleListServiceLeads(request);
}

export async function POST(request: Request) {
  return handleCreateLead(request);
}
