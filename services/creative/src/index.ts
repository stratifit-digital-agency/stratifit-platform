/**
 * @stratifit/creative — Creative / Story bounded context (Stage 2.20).
 * Public API: service factory, repository adapter, and the frozen domain
 * types. Control-only context (D2.20-7): no Media surface, no events
 * (D2.20-4), no publishing mediation.
 */
export { createCreativeService } from "./service";
export { createDrizzleCreativeRepository, type DrizzleCreativeRepositoryDeps } from "./repository";
export * from "./types";
