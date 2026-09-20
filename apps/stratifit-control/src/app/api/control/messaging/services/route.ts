import { handleCreateServiceOffering, handleListServiceOfferings } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/services (service_offerings table — see DOMAIN_MODEL
 * §38 note on the shared-database naming deviation)
 *   GET  — list the org's service offerings (lead.assign)
 *   POST — create a service offering bound to an ACTIVE same-org AI creator
 */
export async function GET(request: Request) {
  return handleListServiceOfferings(request);
}

export async function POST(request: Request) {
  return handleCreateServiceOffering(request);
}
