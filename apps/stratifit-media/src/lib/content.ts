import {
  createDrizzleAudienceRepository,
  createPublicContentReader,
} from "@stratifit/audience";

/**
 * Server-side data access for the public app (Stage 2.13). The Media app
 * reads published content ONLY through the audience module's public read
 * API — never from the publishing internals, production domain, database,
 * or storage layers (enforced by lint boundaries: Media imports the
 * public-safe audience fragment, which owns the database access internally).
 *
 * Stage 2.12 introduced the durable publishing projection behind the
 * PublicationReader interface; Stage 2.13 swaps the public content source to
 * the AUDIENCE public-content projection (invariant 10: public content
 * originates from an approved publication — the audience consumer of
 * `publication.published` is the single write path). The reader exposes ONLY
 * published rows and public-safe fields — slug-addressed, never organization
 * identifiers, internal subject references, worker, or infrastructure data.
 *
 * This composition is READ-ONLY: no auditWriter is configured, so any
 * attempted mutation through this repository fails loudly (mutations belong
 * to the Control composition that wires the event consumers).
 */

const repository = createDrizzleAudienceRepository({
  databaseUrl: process.env.DATABASE_URL as string,
});

export const publicContentReader = createPublicContentReader({
  listContent: () => repository.listPublished(),
  getContentBySlug: (slug) => repository.findBySlug(slug),
});
