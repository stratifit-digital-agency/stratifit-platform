/**
 * @stratifit/rights — Rights & Consent bounded context (Stage 2.21).
 * Public API: service factory, repository adapter, the frozen domain types,
 * and the evaluation seam. Control-only context: no Media surface, no
 * events (D2.21-3), ports unwired (D2.21-2 — cutover is a future stage).
 */
export { createRightsService, evaluateGrantCoverage } from "./service";
export { createDrizzleRightsRepository, type DrizzleRightsRepositoryDeps } from "./repository";
export * from "./types";
