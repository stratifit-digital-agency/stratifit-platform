import {
  DurablePublicationReader,
  DurableStratifitMediaAdapter,
  type PublicationReader,
} from "@stratifit/publishing-engine";

/**
 * Server-side data access for the public app. The Media app reads published
 * content ONLY through the publishing engine's read API — never from the
 * production domain, database, or storage layers (enforced by lint
 * boundaries: Media imports the public-safe publishing-engine service, which
 * owns the database access internally).
 *
 * Stage 2.12: the durable store replaced the in-memory foundation store
 * behind the SAME PublicationReader interface (composition-level swap only).
 * The reader exposes ONLY published rows and public-safe fields — never
 * organization identifiers, internal subject references, worker, or
 * infrastructure data.
 */

const reader = new DurablePublicationReader({
  databaseUrl: process.env.DATABASE_URL as string,
});
void new DurableStratifitMediaAdapter(); // local adapter registered for later wiring

export const publicationReader: PublicationReader = reader.asReader();
