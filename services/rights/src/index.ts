/**
 * @stratifit/rights — Rights & Consent bounded context (Stage 2.21 + 2.22).
 * Public API: service factory, repository adapter, the frozen domain types,
 * the evaluation seam, the requirements-declaration evaluator + the two
 * port adapters (D2.22-4: BUILT + EXPORTED, NOT injected — cutover is a
 * future authorized stage), and the pure subject/platform mapping functions
 * (D2.22-5). Control-only context: no Media surface, no events (D2.21-3).
 */
export {
  createRightsService,
  evaluateGrantCoverage,
  createPublicationRightsAdapter,
  createPeopleRightsAdapter,
  publicationSubjectToRightsSubject,
  platformTargetToRightsPlatform,
} from "./service";
export { createDrizzleRightsRepository, type DrizzleRightsRepositoryDeps } from "./repository";
export * from "./types";
