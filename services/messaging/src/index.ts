/**
 * Messaging & Leads domain service (Stage 2.17, D2.17-1..D2.17-11).
 *
 * Public surface: domain types, the service factory, the Drizzle repository
 * adapter, composition seams (rate limiter + audit writer), and owner-safe /
 * operator-safe projections. Consumers (Control, Media) import ONLY this
 * module — never the database or any other service.
 */
export * from "./types";
export * from "./service";
export * from "./repository";
export * from "./seams";
export * from "./public";
