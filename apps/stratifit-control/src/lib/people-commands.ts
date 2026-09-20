import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getPeopleService } from "./identity";

/**
 * Command handlers for the Stage 2.16 /api/control/people BFF surface
 * (D2.16-4: dedicated people.* capability family — NOT production.publish;
 * D2.16-3: NO route writes creator_profiles — snapshots are
 * publication-authored only).
 *
 * Flow per API_ARCHITECTURE section 11: resolve operator -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> Zod validation
 * -> People service -> section 13 error envelope. Handlers are thin; the
 * route files stay adapters. The actor is always server-derived
 * (authorizeAdminRequest -> resolveControlOperator); no client-controlled
 * identity or organization ever reaches the domain service, and the request
 * schemas contain NO client org_id at all.
 *
 * Response whitelists: chain rows are already public-safe INSIDE Control
 * (operator-only surface); the PUBLIC whitelist lives in Media's BFF layer.
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a People-command error reason to the section 13 error envelope. */
const peopleError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "unauthorized":
      return apiError("forbidden", message, correlationId);
    case "not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "cross_org_reference":
      // Same IDOR-safety: report not_found, never confirm existence.
      return apiError("not_found", "referenced aggregate does not exist", correlationId);
    case "invalid_handle":
    case "invalid_input":
      return apiError("validation_error", message, correlationId);
    case "inactive_parent":
    case "chain_broken":
    case "invalid_status_transition":
      return apiError("domain_rule_violation", message, correlationId);
    default:
      return apiError("internal_error", "unexpected domain rejection", correlationId);
  }
};

const validationFrom = (issues: { path: (string | number | symbol)[]; message: string }[], correlationId: string) =>
  apiError("validation_error", "request payload failed validation", correlationId, {
    fieldErrors: issues.map((i) => ({ field: i.path.map(String).join(".") || "body", message: i.message })),
  });

// ---------------------------------------------------------------------------
// Strict request schemas (no client org/identity authority anywhere)
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

export const CreateDigitalHumanRequest = z
  .object({
    name: z.string().min(1).max(200),
    appearanceRefs: z.array(uuid).max(20).optional(),
    baseModelVersionRef: uuid.nullish(),
    baseWorkflowVersionRef: uuid.nullish(),
  })
  .strict();

export const CreateCharacterRequest = z
  .object({
    digitalHumanId: uuid.nullish(),
    name: z.string().min(1).max(200),
    bio: z.string().max(2000).nullish(),
    visualRefs: z.array(uuid).max(20).optional(),
  })
  .strict();

export const CreatePersonaRequest = z
  .object({
    characterId: uuid,
    name: z.string().min(1).max(200),
    personality: z.string().max(4000).nullish(),
    interests: z.array(z.string().max(64)).max(30).optional(),
    capabilities: z.array(z.string().max(64)).max(30).optional(),
    languages: z.array(z.string().max(32)).max(20).optional(),
    behaviorConfig: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const CreateAiCreatorRequest = z
  .object({
    personaId: uuid,
    handle: z.string().regex(/^[a-z0-9-]{3,64}$/),
    displayName: z.string().min(1).max(200),
    capabilities: z.array(z.string().max(64)).max(30).optional(),
    contentCategories: z.array(z.string().max(64)).max(30).optional(),
    communicationConfig: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const ChangeStatusRequest = z
  .object({
    // Vocabulary union; the service gates per kind ("paused" is valid ONLY for
    // ai_creator) and enforces the per-kind lifecycle transition table.
    status: z.enum(["draft", "active", "paused", "retired"]),
  })
  .strict();

const PeopleAggregateKindParam = z.enum(["digital-humans", "characters", "personas", "ai-creators"]);
export type PeopleAggregateParam = z.infer<typeof PeopleAggregateKindParam>;

/** Map the URL aggregate segment to the service's kind union. */
export const aggregateKindFromParam = (
  param: PeopleAggregateParam,
): "digital_human" | "character" | "persona" | "ai_creator" =>
  param === "digital-humans" ? "digital_human" : param === "characters" ? "character" : param === "personas" ? "persona" : "ai_creator";

const peoplePrincipal = (auth: AuthedContext) => ({
  operatorId: auth.actor.operatorId,
  orgId: auth.actor.organizationId,
  capabilities: auth.actor.capabilities,
});

// ---------------------------------------------------------------------------
// Authoring handlers (people.manage)
// ---------------------------------------------------------------------------

export const handleCreateDigitalHuman = async (request: Request) => {
  const auth = await authorizeAdminRequest("people.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateDigitalHumanRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getPeopleService().createDigitalHuman(peoplePrincipal(auth), {
    name: parsed.data.name,
    appearanceRefs: parsed.data.appearanceRefs ?? [],
    baseModelVersionRef: parsed.data.baseModelVersionRef ?? null,
    baseWorkflowVersionRef: parsed.data.baseWorkflowVersionRef ?? null,
  });
  return result.ok ? apiOk(result.value, 201) : peopleError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleCreateCharacter = async (request: Request) => {
  const auth = await authorizeAdminRequest("people.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateCharacterRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getPeopleService().createCharacter(peoplePrincipal(auth), {
    digitalHumanId: parsed.data.digitalHumanId ?? null,
    name: parsed.data.name,
    bio: parsed.data.bio ?? null,
    visualRefs: parsed.data.visualRefs ?? [],
  });
  return result.ok ? apiOk(result.value, 201) : peopleError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleCreatePersona = async (request: Request) => {
  const auth = await authorizeAdminRequest("people.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreatePersonaRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getPeopleService().createPersona(peoplePrincipal(auth), {
    characterId: parsed.data.characterId,
    name: parsed.data.name,
    personality: parsed.data.personality ?? null,
    interests: parsed.data.interests ?? [],
    capabilities: parsed.data.capabilities ?? [],
    languages: parsed.data.languages ?? [],
    behaviorConfig: parsed.data.behaviorConfig ?? {},
  });
  return result.ok ? apiOk(result.value, 201) : peopleError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleCreateAiCreator = async (request: Request) => {
  const auth = await authorizeAdminRequest("people.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateAiCreatorRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getPeopleService().createAiCreator(peoplePrincipal(auth), {
    personaId: parsed.data.personaId,
    handle: parsed.data.handle,
    displayName: parsed.data.displayName,
    capabilities: parsed.data.capabilities ?? [],
    contentCategories: parsed.data.contentCategories ?? [],
    communicationConfig: parsed.data.communicationConfig ?? {},
  });
  return result.ok ? apiOk(result.value, 201) : peopleError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleChangeStatus = async (request: Request, aggregateParam: string, id: string) => {
  const auth = await authorizeAdminRequest("people.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const kindParam = PeopleAggregateKindParam.safeParse(aggregateParam);
  if (!kindParam.success) {
    return apiError("not_found", "unknown people aggregate", auth.correlationId);
  }
  const body = await request.json().catch(() => null);
  const parsed = ChangeStatusRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getPeopleService().changeStatus(peoplePrincipal(auth), aggregateKindFromParam(kindParam.data), {
    id,
    status: parsed.data.status,
  });
  return result.ok ? apiOk(result.value) : peopleError(result.error.reason, result.error.message, auth.correlationId);
};

// ---------------------------------------------------------------------------
// Read handlers (people.read)
// ---------------------------------------------------------------------------

const LIMIT_QUERY = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).strict();

export const handleListPeople = async (request: Request, aggregateParam: string) => {
  const auth = await authorizeAdminRequest("people.read" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const kindParam = PeopleAggregateKindParam.safeParse(aggregateParam);
  if (!kindParam.success) {
    return apiError("not_found", "unknown people aggregate", auth.correlationId);
  }
  const query = LIMIT_QUERY.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return validationFrom(query.error.issues, auth.correlationId);
  const principal = peoplePrincipal(auth);
  const limit = query.data.limit;
  const svc = getPeopleService();
  const result =
    kindParam.data === "digital-humans"
      ? await svc.listDigitalHumans(principal, limit)
      : kindParam.data === "characters"
        ? await svc.listCharacters(principal, limit)
        : kindParam.data === "personas"
          ? await svc.listPersonas(principal, limit)
          : await svc.listAiCreators(principal, limit);
  if (!result.ok) return peopleError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ items: result.value });
};

/** GET /api/control/people/profiles — org-scoped snapshot family read (people.read). */
export const handleListProfiles = async (request: Request) => {
  const auth = await authorizeAdminRequest("people.read" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const query = LIMIT_QUERY.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return validationFrom(query.error.issues, auth.correlationId);
  const result = await getPeopleService().listProfiles(peoplePrincipal(auth), query.data.limit);
  if (!result.ok) return peopleError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ items: result.value });
};
