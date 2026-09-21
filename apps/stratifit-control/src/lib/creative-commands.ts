import type { NextResponse } from "next/server";
import type { ControlCapability } from "@stratifit/permissions";
import { z } from "zod";
import {
  authorizeAdminRequest,
  type AuthedContext,
  type AuthError,
} from "./admin-commands";
import { apiError, apiOk } from "./api";
import { getCreativeService } from "./identity";
import type { CreativeAggregateKind, CreativeResult } from "@stratifit/creative";
type CreativeRow =
  | import("@stratifit/creative").UniverseRecord
  | import("@stratifit/creative").WorldRecord
  | import("@stratifit/creative").StoryRecord
  | import("@stratifit/creative").SeasonRecord
  | import("@stratifit/creative").EpisodeRecord
  | import("@stratifit/creative").SceneRecord
  | import("@stratifit/creative").ShotRecord;

/**
 * Command handlers for the Stage 2.20 /api/control/creative BFF surface
 * (D2.20-5: dedicated creative.* capability family — never production.*;
 * D2.20-7: Control-ONLY context — no Media surface exists and none is
 * created here).
 *
 * Flow per API_ARCHITECTURE section 11: resolve operator -> 401
 * `unauthenticated` -> capability check -> 403 `forbidden` -> Zod validation
 * -> Creative service -> section 13 error envelope. Handlers are thin; the
 * route files stay adapters. The actor is always server-derived
 * (authorizeAdminRequest -> resolveControlOperator); no client-controlled
 * identity or organization ever reaches the domain service, and every
 * request schema contains NO client org/authority field (strict Zod —
 * unknown fields rejected).
 */

const isAuthError = (r: AuthedContext | AuthError): r is AuthError => "response" in r;

/** Map a Creative-command error reason to the section 13 error envelope. */
const creativeError = (reason: string, message: string, correlationId: string): NextResponse => {
  switch (reason) {
    case "unauthorized":
      return apiError("forbidden", message, correlationId);
    case "not_found":
      // Cross-org targets are indistinguishable from absent ones (IDOR-safe).
      return apiError("not_found", message, correlationId);
    case "cross_org_reference":
      // Same IDOR-safety: report not_found, never confirm existence.
      return apiError("not_found", "referenced aggregate does not exist", correlationId);
    case "invalid_slug":
    case "duplicate_slug":
    case "invalid_input":
      return apiError("validation_error", message, correlationId);
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

export const CreateUniverseRequest = z
  .object({
    name: z.string().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9-]{3,64}$/),
    description: z.string().max(4000).nullish(),
  })
  .strict();

export const CreateWorldRequest = z
  .object({
    universeId: uuid,
    name: z.string().min(1).max(200),
    description: z.string().max(4000).nullish(),
  })
  .strict();

export const CreateStoryRequest = z
  .object({
    worldId: uuid.nullish(),
    universeId: uuid.nullish(),
    title: z.string().min(1).max(300),
    logline: z.string().min(1).max(1000),
    kind: z.enum(["film", "series", "short", "campaign_narrative"]),
    version: z.number().int().min(1).optional(),
  })
  .strict();

export const CreateSeasonRequest = z
  .object({
    storyId: uuid,
    seasonNumber: z.number().int().min(1),
    title: z.string().min(1).max(300),
  })
  .strict();

export const CreateEpisodeRequest = z
  .object({
    seasonId: uuid.nullish(),
    storyId: uuid.nullish(),
    // D2.20: nullable, creation-time anchor only — no update path exists.
    productionId: uuid.nullish(),
    episodeNumber: z.number().int().min(1),
    title: z.string().min(1).max(300),
  })
  .strict();

export const CreateSceneRequest = z
  .object({
    storyId: uuid.nullish(),
    episodeId: uuid.nullish(),
    // D2.20: nullable, creation-time anchor only — no update path exists.
    productionId: uuid.nullish(),
    orderIndex: z.number().int().min(0),
    title: z.string().min(1).max(300),
    synopsis: z.string().max(4000).nullish(),
  })
  .strict();

export const CreateShotRequest = z
  .object({
    sceneId: uuid,
    orderIndex: z.number().int().min(0),
    description: z.string().min(1).max(2000),
    aspect: z.string().min(1).max(20),
    durationSeconds: z.number().int().min(1),
    fps: z.number().int().min(1).max(240),
  })
  .strict();

export const ChangeStatusRequest = z
  .object({
    // Vocabulary union; the service gates per kind ("completed" is valid ONLY
    // for stories) and enforces the per-kind lifecycle transition table.
    status: z.enum(["draft", "active", "completed", "retired"]),
  })
  .strict();

const CreativeAggregateParam = z.enum([
  "universes",
  "worlds",
  "stories",
  "seasons",
  "episodes",
  "scenes",
  "shots",
]);
export type CreativeAggregateParam = z.infer<typeof CreativeAggregateParam>;

/** Map the URL aggregate segment to the service's kind union. */
export const aggregateKindFromParam = (
  param: CreativeAggregateParam,
): CreativeAggregateKind => {
  switch (param) {
    case "universes":
      return "universe";
    case "worlds":
      return "world";
    case "stories":
      return "story";
    case "seasons":
      return "season";
    case "episodes":
      return "episode";
    case "scenes":
      return "scene";
    case "shots":
      return "shot";
  }
};

const creativePrincipal = (auth: AuthedContext) => ({
  operatorId: auth.actor.operatorId,
  orgId: auth.actor.organizationId,
  capabilities: auth.actor.capabilities,
});

// ---------------------------------------------------------------------------
// Authoring handlers (creative.manage)
// ---------------------------------------------------------------------------

export const handleCreateCreative = async (request: Request, aggregateParam: string) => {
  const auth = await authorizeAdminRequest("creative.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const kindParam = CreativeAggregateParam.safeParse(aggregateParam);
  if (!kindParam.success) {
    return apiError("not_found", "unknown creative aggregate", auth.correlationId);
  }
  const body = await request.json().catch(() => null);
  const svc = getCreativeService();
  const principal = creativePrincipal(auth);
  let result: CreativeResult<CreativeRow>;
  switch (kindParam.data) {
    case "universes": {
      const parsed = CreateUniverseRequest.safeParse(body);
      if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
      result = await svc.createUniverse(principal, {
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: parsed.data.description ?? null,
      });
      break;
    }
    case "worlds": {
      const parsed = CreateWorldRequest.safeParse(body);
      if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
      result = await svc.createWorld(principal, {
        universeId: parsed.data.universeId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
      });
      break;
    }
    case "stories": {
      const parsed = CreateStoryRequest.safeParse(body);
      if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
      result = await svc.createStory(principal, {
        worldId: parsed.data.worldId ?? null,
        universeId: parsed.data.universeId ?? null,
        title: parsed.data.title,
        logline: parsed.data.logline,
        kind: parsed.data.kind,
        version: parsed.data.version ?? 1,
      });
      break;
    }
    case "seasons": {
      const parsed = CreateSeasonRequest.safeParse(body);
      if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
      result = await svc.createSeason(principal, {
        storyId: parsed.data.storyId,
        seasonNumber: parsed.data.seasonNumber,
        title: parsed.data.title,
      });
      break;
    }
    case "episodes": {
      const parsed = CreateEpisodeRequest.safeParse(body);
      if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
      result = await svc.createEpisode(principal, {
        seasonId: parsed.data.seasonId ?? null,
        storyId: parsed.data.storyId ?? null,
        productionId: parsed.data.productionId ?? null,
        episodeNumber: parsed.data.episodeNumber,
        title: parsed.data.title,
      });
      break;
    }
    case "scenes": {
      const parsed = CreateSceneRequest.safeParse(body);
      if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
      result = await svc.createScene(principal, {
        storyId: parsed.data.storyId ?? null,
        episodeId: parsed.data.episodeId ?? null,
        productionId: parsed.data.productionId ?? null,
        orderIndex: parsed.data.orderIndex,
        title: parsed.data.title,
        synopsis: parsed.data.synopsis ?? null,
      });
      break;
    }
    case "shots": {
      const parsed = CreateShotRequest.safeParse(body);
      if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
      result = await svc.createShot(principal, {
        sceneId: parsed.data.sceneId,
        orderIndex: parsed.data.orderIndex,
        description: parsed.data.description,
        aspect: parsed.data.aspect,
        durationSeconds: parsed.data.durationSeconds,
        fps: parsed.data.fps,
      });
      break;
    }
  }
  return result.ok ? apiOk(result.value, 201) : creativeError(result.error.reason, result.error.message, auth.correlationId);
};

// ---------------------------------------------------------------------------
// Lifecycle handlers (creative.manage, D2.20-6)
// ---------------------------------------------------------------------------

export const handleChangeCreativeStatus = async (request: Request, aggregateParam: string, id: string) => {
  const auth = await authorizeAdminRequest("creative.manage" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const kindParam = CreativeAggregateParam.safeParse(aggregateParam);
  if (!kindParam.success) {
    return apiError("not_found", "unknown creative aggregate", auth.correlationId);
  }
  const body = await request.json().catch(() => null);
  const parsed = ChangeStatusRequest.safeParse(body);
  if (!parsed.success) return validationFrom(parsed.error.issues, auth.correlationId);
  const result = await getCreativeService().changeStatus(
    creativePrincipal(auth),
    aggregateKindFromParam(kindParam.data),
    { id, status: parsed.data.status },
  );
  return result.ok ? apiOk(result.value) : creativeError(result.error.reason, result.error.message, auth.correlationId);
};

// ---------------------------------------------------------------------------
// Read handlers (creative.read)
// ---------------------------------------------------------------------------

const LIMIT_QUERY = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).strict();

export const handleListCreative = async (request: Request, aggregateParam: string) => {
  const auth = await authorizeAdminRequest("creative.read" as ControlCapability, request);
  if (isAuthError(auth)) return auth.response;
  const kindParam = CreativeAggregateParam.safeParse(aggregateParam);
  if (!kindParam.success) {
    return apiError("not_found", "unknown creative aggregate", auth.correlationId);
  }
  const query = LIMIT_QUERY.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return validationFrom(query.error.issues, auth.correlationId);
  const principal = creativePrincipal(auth);
  const limit = query.data.limit;
  const svc = getCreativeService();
  const result =
    kindParam.data === "universes"
      ? await svc.listUniverses(principal, limit)
      : kindParam.data === "worlds"
        ? await svc.listWorlds(principal, limit)
        : kindParam.data === "stories"
          ? await svc.listStories(principal, limit)
          : kindParam.data === "seasons"
            ? await svc.listSeasons(principal, limit)
            : kindParam.data === "episodes"
              ? await svc.listEpisodes(principal, limit)
              : kindParam.data === "scenes"
                ? await svc.listScenes(principal, limit)
                : await svc.listShots(principal, limit);
  if (!result.ok) return creativeError(result.error.reason, result.error.message, auth.correlationId);
  return apiOk({ items: result.value });
};
