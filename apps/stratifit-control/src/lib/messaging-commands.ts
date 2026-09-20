import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getMessagingService } from "./identity";

/**
 * Command handlers for the Stage 2.17 /api/control/messaging BFF surface
 * (D2.17-6: existing messaging.takeover / lead.assign capabilities only — no
 * new permission).
 *
 * Flow per API_ARCHITECTURE section 11: resolve operator -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> Zod validation
 * -> messaging service -> section 13 error envelope. Handlers are thin; the
 * route files stay adapters. The operator identity/organization is ALWAYS
 * server-derived (authorizeAdminRequest -> resolveControlOperator); request
 * schemas contain NO client org/actor authority fields.
 *
 * Capability map (frozen): conversation read/reply/takeover and all
 * conversation-scoped reads use messaging.takeover (admin+operator); service
 * offering / inquiry / lead surfaces use lead.assign (admin+operator).
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a messaging-command error reason to the section 13 error envelope. */
const messagingError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "unauthorized":
      return apiError("forbidden", message, correlationId);
    case "not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "cross_org_reference":
      // Same IDOR-safety: report not_found, never confirm existence.
      return apiError("not_found", "referenced aggregate does not exist", correlationId);
    case "rate_limited":
      return apiError("rate_limited", message, correlationId);
    case "invalid_input":
      return apiError("validation_error", message, correlationId);
    case "conflict":
      return apiError("conflict", message, correlationId);
    case "inactive_parent":
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
const body = z.string().min(1).max(4000);
const limit = z.coerce.number().int().min(1).max(200).optional();

const ListConversationsRequest = z.object({ limit }).strict();

const ReplyConversationRequest = z.object({ body }).strict();

const CreateServiceOfferingRequest = z
  .object({
    aiCreatorId: uuid,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    category: z.string().max(64).optional(),
  })
  .strict();

const SetServiceOfferingStatusRequest = z.object({ status: z.enum(["active", "retired"]) }).strict();

const ClassifyInquiryRequest = z
  .object({
    conversationId: uuid,
    messageId: uuid,
    classification: z.string().min(1).max(200),
    requestedServiceId: uuid.nullish(),
  })
  .strict();

const CreateLeadRequest = z.object({ conversationId: uuid, serviceInquiryId: uuid }).strict();

const AssignLeadRequest = z.object({ operatorId: uuid.nullish() }).strict();

const SetLeadStatusRequest = z
  .object({
    status: z.enum(["new", "triaged", "assigned", "in_progress", "won", "lost", "archived"]),
  })
  .strict();

const RecordFollowUpRequest = z.object({ note: z.string().min(1).max(2000) }).strict();

const operatorPrincipal = (auth: AuthedContext) => ({
  kind: "operator" as const,
  operatorId: auth.actor.operatorId,
  orgId: auth.actor.organizationId,
  capabilities: auth.actor.capabilities,
});

const takeover = "messaging.takeover" as ControlCapability;
const assign = "lead.assign" as ControlCapability;

// ---------------------------------------------------------------------------
// Conversations (messaging.takeover)
// ---------------------------------------------------------------------------

export const handleListInbox = async (request: Request) => {
  const auth = await authorizeAdminRequest(takeover, request);
  if (isAuthError(auth)) return auth.response;
  const url = new URL(request.url);
  const parsed = ListConversationsRequest.safeParse(url.searchParams.size ? Object.fromEntries(url.searchParams) : {});
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().listInbox(operatorPrincipal(auth), parsed.data.limit === undefined ? {} : { limit: parsed.data.limit });
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleGetConversation = async (request: Request, conversationId: string) => {
  const auth = await authorizeAdminRequest(takeover, request);
  if (isAuthError(auth)) return auth.response;
  const result = await getMessagingService().getConversation(operatorPrincipal(auth), conversationId);
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleReplyConversation = async (request: Request, conversationId: string) => {
  const auth = await authorizeAdminRequest(takeover, request);
  if (isAuthError(auth)) return auth.response;
  const parsed = ReplyConversationRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().reply(operatorPrincipal(auth), {
    conversationId,
    body: parsed.data.body,
  });
  return result.ok ? apiOk(result.value, 201) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleTakeover = async (request: Request, conversationId: string) => {
  const auth = await authorizeAdminRequest(takeover, request);
  if (isAuthError(auth)) return auth.response;
  const result = await getMessagingService().takeover(operatorPrincipal(auth), conversationId);
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

// ---------------------------------------------------------------------------
// Service offerings (lead.assign)
// ---------------------------------------------------------------------------

export const handleCreateServiceOffering = async (request: Request) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const parsed = CreateServiceOfferingRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().createServiceOffering(operatorPrincipal(auth), {
    aiCreatorId: parsed.data.aiCreatorId,
    name: parsed.data.name,
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
  });
  return result.ok ? apiOk(result.value, 201) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleListServiceOfferings = async (request: Request) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const url = new URL(request.url);
  const parsed = ListConversationsRequest.safeParse(url.searchParams.size ? Object.fromEntries(url.searchParams) : {});
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().listServiceOfferings(operatorPrincipal(auth), parsed.data.limit === undefined ? {} : { limit: parsed.data.limit });
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleSetServiceOfferingStatus = async (request: Request, offeringId: string) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const parsed = SetServiceOfferingStatusRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().setServiceOfferingStatus(operatorPrincipal(auth), {
    id: offeringId,
    status: parsed.data.status,
  });
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

// ---------------------------------------------------------------------------
// Inquiries (lead.assign)
// ---------------------------------------------------------------------------

export const handleListServiceInquiries = async (request: Request) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const url = new URL(request.url);
  const parsed = ListConversationsRequest.safeParse(url.searchParams.size ? Object.fromEntries(url.searchParams) : {});
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().listServiceInquiries(operatorPrincipal(auth), parsed.data.limit === undefined ? {} : { limit: parsed.data.limit });
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleClassifyInquiry = async (request: Request) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const parsed = ClassifyInquiryRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().classifyInquiry(operatorPrincipal(auth), {
    conversationId: parsed.data.conversationId,
    messageId: parsed.data.messageId,
    classification: parsed.data.classification,
    requestedServiceId: parsed.data.requestedServiceId ?? null,
  });
  return result.ok ? apiOk(result.value, 201) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

// ---------------------------------------------------------------------------
// Leads (lead.assign)
// ---------------------------------------------------------------------------

export const handleListServiceLeads = async (request: Request) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const url = new URL(request.url);
  const parsed = ListConversationsRequest.safeParse(url.searchParams.size ? Object.fromEntries(url.searchParams) : {});
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().listServiceLeads(operatorPrincipal(auth), parsed.data.limit === undefined ? {} : { limit: parsed.data.limit });
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleGetServiceLead = async (request: Request, leadId: string) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const result = await getMessagingService().getServiceLead(operatorPrincipal(auth), leadId);
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleCreateLead = async (request: Request) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const parsed = CreateLeadRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().createLead(operatorPrincipal(auth), {
    conversationId: parsed.data.conversationId,
    serviceInquiryId: parsed.data.serviceInquiryId,
  });
  return result.ok ? apiOk(result.value, 201) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleAssignLead = async (request: Request, leadId: string) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const parsed = AssignLeadRequest.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().assignLead(operatorPrincipal(auth), {
    leadId,
    operatorId: parsed.data.operatorId ?? null,
  });
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleSetLeadStatus = async (request: Request, leadId: string) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const parsed = SetLeadStatusRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().setLeadStatus(operatorPrincipal(auth), {
    leadId,
    status: parsed.data.status,
  });
  return result.ok ? apiOk(result.value) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};

export const handleRecordFollowUp = async (request: Request, leadId: string) => {
  const auth = await authorizeAdminRequest(assign, request);
  if (isAuthError(auth)) return auth.response;
  const parsed = RecordFollowUpRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getMessagingService().recordFollowUp(operatorPrincipal(auth), {
    leadId,
    note: parsed.data.note,
  });
  return result.ok ? apiOk(result.value, 201) : messagingError(result.error.reason, result.error.message, auth.correlationId);
};
