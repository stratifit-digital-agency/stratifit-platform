import {
  InMemoryPublicationStore,
  StratifitMediaAdapter,
  type PublicationReader,
} from "@stratifit/publishing-engine";

/**
 * Server-side data access for the public app. The Media app reads published
 * content ONLY through the publishing engine's read API — never from the
 * production domain, database, or storage layers (enforced by lint boundaries).
 *
 * In the foundation the store is in-memory; a durable store replaces it later
 * behind the same PublicationReader interface.
 */

const store = new InMemoryPublicationStore();
void new StratifitMediaAdapter(store); // adapter registered for later wiring

export const publicationReader: PublicationReader = store;
