/**
 * Public-safe People projections (Stage 2.16, D2.16-8).
 *
 * The ONLY shapes Media may receive. Every field here is public-safe:
 * handles/display names/bios/interests plus OPAQUE asset refs — never
 * internal row ids, org ids, publication ids, storage paths/URLs, or
 * credentials. Only status='active' profiles are projected (inactive
 * profiles are invisible to the public surface).
 */
import type { CreatorProfileRecord, PublicCreatorView } from "./types";

export const toPublicCreatorView = (row: CreatorProfileRecord): PublicCreatorView => ({
  handle: row.handle,
  displayName: row.displayName,
  bio: row.bio,
  interests: row.interestsSnapshot,
  avatarRef: row.avatarRef, // opaque asset-version reference, NOT a URL
  posterRef: row.posterRef,
  status: row.status === "active" ? "active" : "paused",
});

export const toPublicCreatorViews = (rows: readonly CreatorProfileRecord[]): PublicCreatorView[] =>
  rows.filter((r) => r.status === "active").map(toPublicCreatorView);
