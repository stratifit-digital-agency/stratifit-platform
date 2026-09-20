import { handleClassifyInquiry, handleListServiceInquiries } from "@/lib/messaging-commands";

export const dynamic = "force-dynamic";

/**
 * /api/control/messaging/inquiries
 *   GET  — list the org's service inquiries (lead.assign)
 *   POST — classify a conversation message into a service inquiry (lead.assign;
 *          one inquiry per message — duplicates conflict)
 */
export async function GET(request: Request) {
  return handleListServiceInquiries(request);
}

export async function POST(request: Request) {
  return handleClassifyInquiry(request);
}
