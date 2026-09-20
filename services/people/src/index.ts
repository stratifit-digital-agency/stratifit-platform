/**
 * @stratifit/people — People bounded context (Stage 2.16).
 * Public API: service factory, repository adapter, narrow read-only seams,
 * and the public-safe view projections. Chain-internals stay internal.
 */
export { createPeopleService } from "./service";
export { createDrizzlePeopleRepository, type DrizzlePeopleRepositoryDeps } from "./repository";
export { createCreatorFollowPort, createCreatorSubjectPort } from "./seams";
export { toPublicCreatorView, toPublicCreatorViews } from "./public";
export * from "./types";
