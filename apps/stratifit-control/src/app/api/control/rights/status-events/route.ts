import { z } from "zod";
import { apiError, apiOk } from "@/lib/api";
import { authorizeAdminRequest, type AuthError, type AuthedContext } from "@/lib/admin-commands";
import { getRightsService } from "@/lib/identity";

export const dynamic = "force-dynamic";

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

const GRANT_ID_QUERY = z
  .object({ grantId: z.string().uuid() })
  .strict();

/**
 * /api/control/rights/status-events?grantId=<uuid>
 *   GET — the immutable status-event history for one grant (rights.read).
 * D2.21-3: this history is the authoritative record of grant status
 * transitions; no rights.* event-bus events exist.
 */
export async function GET(request: Request) {
  const auth = await authorizeAdminRequest("rights.read" as never, request);
  if (isAuthError(auth)) return auth.response;
  const query = GRANT_ID_QUERY.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) {
    return apiError(
      "validation_error",
      "request payload failed validation",
      auth.correlationId,
      {
        fieldErrors: query.error.issues.map((i) => ({
          field: i.path.map(String).join(".") || "query",
          message: i.message,
        })),
      },
    );
  }
  // Reuse the grant-detail read (same org-scoped + IDOR-safe semantics); the
  // history slice is the status-event projection of that record.
  const result = await getRightsService().getGrant(
    {
      operatorId: auth.actor.operatorId,
      orgId: auth.actor.organizationId,
      capabilities: auth.actor.capabilities,
    },
    query.data.grantId,
  );
  if (!result.ok) {
    const code = result.error.reason === "unauthorized" ? "forbidden" : "not_found";
    return apiError(code, result.error.message, auth.correlationId);
  }
  return apiOk({ items: result.value.history });
}
