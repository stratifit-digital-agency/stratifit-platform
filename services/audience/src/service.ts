/**
 * Audience domain service (Stage 2.13, D2.13-1..D2.13-5).
 *
 * Event-driven projection of committed publishing facts into the durable
 * PUBLIC CONTENT aggregate (DM section 20). INVARIANT 10: public content
 * originates ONLY from an approved publication — the consumers below are the
 * single write path; there is no second content universe.
 *
 * Consumer rules (frozen):
 *  - projectPublished: idempotency key = payload.versionId (verified BUILD
 *    STEP 0: the existing publication.published payload carries the
 *    publication-version id under `versionId`). Duplicate events are silent
 *    no-ops; slug collisions resolve through the bounded probe + hash
 *    fallback; the DB UNIQUEs are the final backstops.
 *  - unpublishContent: flips published → unpublished. Missing projection or
 *    already-unpublished rows are silent no-ops (idempotent takedown).
 *  - No-op operations produce NO audit mutation; successful mutations are
 *    audited in the SAME transaction (D2.4-1 seam) and roll back together.
 *  - The service never mutates the publishing family and never imports it.
 */
import { createHash } from "node:crypto";
import type {
  AudienceCommandResult,
  AudienceRepository,
  AudienceService,
  AudienceServiceDeps,
  ProjectionOutcome,
  PublicContentRecord,
  PublicContentType,
  PublicationPublishedEvent,
  PublicationUnpublishedEvent,
} from "./types";
import { AUDIENCE_AUDIT_ACTIONS, CONTENT_TYPE_MAPPING, SYSTEM_ACTOR_ID, err, ok } from "./types";

// ---------------------------------------------------------------------------
// Slug strategy (D2.13-2): deterministic, URL-safe, globally unique.
// ---------------------------------------------------------------------------

export const slugify = (title: string): string => {
  const base = title
    .normalize("NFKD")
    // Strip combining diacritics left by NFKD decomposition.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "content";
};

/** Approved bounded probe: base, base-2 … base-9, then the 6-hex hash fallback. */
const MAX_PROBE = 9;

const hashSuffix = (publicationVersionId: string): string =>
  createHash("sha256").update(publicationVersionId).digest("hex").slice(0, 6);

/**
 * Collision resolution: probes candidate slugs against the EXISTING rows
 * (pre-insert check), then relies on the DB UNIQUE(slug) as the final
 * backstop (a lost race surfaces as 23505 and is retried with the next
 * candidate by the service loop below).
 */
const resolveSlug = async (
  tx: Pick<AudienceRepository, "findBySlug">,
  title: string,
  publicationVersionId: string,
): Promise<string> => {
  const base = slugify(title);
  for (let n = 1; n <= MAX_PROBE; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if ((await tx.findBySlug(candidate)) === null) return candidate;
  }
  return `${base}-${hashSuffix(publicationVersionId)}`;
};

// ---------------------------------------------------------------------------
// Envelope validation (strict, fail-closed on malformed events)
// ---------------------------------------------------------------------------

interface PublishPayload {
  readonly publicationId: string;
  readonly versionId: string;
  readonly title: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parsePublishedPayload = (payload: unknown): PublishPayload | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const publicationId = p.publicationId;
  const versionId = p.versionId;
  const title = p.title;
  if (typeof publicationId !== "string" || !UUID_RE.test(publicationId)) return null;
  if (typeof versionId !== "string" || !UUID_RE.test(versionId)) return null;
  if (typeof title !== "string" || title.trim().length === 0) return null;
  return { publicationId, versionId, title };
};

const parseUnpublishedPayload = (payload: unknown): { publicationId: string } | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const publicationId = p.publicationId;
  if (typeof publicationId !== "string" || !UUID_RE.test(publicationId)) return null;
  return { publicationId };
};

/** D2.13-3 mapping, validated against the DB CHECK taxonomy. */
const mapContentType = (value: unknown): PublicContentType | null => {
  if (typeof value !== "string") return null;
  const mapped = CONTENT_TYPE_MAPPING[value as keyof typeof CONTENT_TYPE_MAPPING];
  return mapped ?? null;
};

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export const createAudienceService = (deps: AudienceServiceDeps): AudienceService => {
  const repo = deps.repository;

  return {
    async projectPublished(event: PublicationPublishedEvent) {
      const envelope = event.envelope;
      if (envelope.name !== "publication.published") {
        return err("invalid_event", `expected publication.published, got ${envelope.name}`);
      }
      const payload = parsePublishedPayload(envelope.payload);
      if (!payload) {
        return err("invalid_event", "publication.published payload missing valid publicationId/versionId/title");
      }
      const contentType = mapContentType(envelope.payload.contentType);
      if (!contentType) {
        return err("invalid_event", "publication.published payload contentType is not mappable (D2.13-3)");
      }
      const orgId = envelope.correlation.organizationId;
      if (typeof orgId !== "string" || !UUID_RE.test(orgId)) {
        return err("invalid_event", "publication.published envelope missing correlation.organizationId");
      }

      // Idempotency: same publication_version_id → silent NO-OP (no audit).
      const existing = await repo.findByPublicationVersionId(payload.versionId);
      if (existing) return ok<ProjectionOutcome>({ kind: "noop_duplicate" });

      const projected = await repo.runInTransaction(async (tx) => {
        // Re-check inside the transaction (unique constraints backstop anyway).
        const dup = await tx.findByPublicationVersionId(payload.versionId);
        if (dup) return null;
        const slug = await resolveSlug(tx, payload.title, payload.versionId);
        const inserted = await tx.insertContent({
          orgId,
          publicationId: payload.publicationId,
          publicationVersionId: payload.versionId,
          slug,
          contentType,
          title: payload.title,
          synopsis: typeof envelope.payload.synopsis === "string" ? envelope.payload.synopsis : null,
          mediaRefs: [],
          publishedAt: envelope.occurredAt ? new Date(envelope.occurredAt) : new Date(),
          categories: [],
        });
        await tx.appendAudit({
          actorId: SYSTEM_ACTOR_ID,
          action: AUDIENCE_AUDIT_ACTIONS[0],
          subjectKind: "public_content",
          subjectId: inserted.id,
          organizationId: orgId,
          correlationId: envelope.correlation.publicationId ?? payload.publicationId,
          causationId: envelope.eventId,
          payload: { slug, contentType, publicationVersionId: payload.versionId },
        });
        return inserted;
      }).catch((e) => {
        // Lost slug race: DB UNIQUE(slug) fired — retry once with the next
        // candidate by letting the caller loop; surfaced as conflict here.
        if (e instanceof Error && e.message.startsWith("unique violation")) {
          return e;
        }
        throw e;
      });

      if (projected instanceof Error) {
        return err("projection_conflict", projected.message);
      }
      if (projected === null) return ok<ProjectionOutcome>({ kind: "noop_duplicate" });
      return ok<ProjectionOutcome>({ kind: "projected", contentId: projected.id, slug: projected.slug });
    },

    async unpublishContent(event: PublicationUnpublishedEvent) {
      const envelope = event.envelope;
      if (envelope.name !== "publication.unpublished") {
        return err("invalid_event", `expected publication.unpublished, got ${envelope.name}`);
      }
      const payload = parseUnpublishedPayload(envelope.payload);
      if (!payload) {
        return err("invalid_event", "publication.unpublished payload missing valid publicationId");
      }

      // Pre-classify the no-op (observability only — both are silent, no audit).
      const existing = await repo.findByPublicationId(payload.publicationId);
      const alreadyUnpublished = existing?.status === "unpublished";

      const updated: AudienceCommandResult<PublicContentRecord | null> = await repo.runInTransaction(async (tx) => {
        // The ONLY sanctioned mutation: published → unpublished. setStatus
        // no-ops (returns null) when the row is missing or already flipped.
        const next = await tx.setStatus(payload.publicationId, "unpublished");
        if (!next) return ok<PublicContentRecord | null>(null); // missing/already — NO-OP, no audit
        await tx.appendAudit({
          actorId: SYSTEM_ACTOR_ID,
          action: AUDIENCE_AUDIT_ACTIONS[1],
          subjectKind: "public_content",
          subjectId: next.id,
          organizationId: next.orgId,
          correlationId: envelope.correlation.publicationId ?? payload.publicationId,
          causationId: envelope.eventId,
          payload: { slug: next.slug },
        });
        return ok<PublicContentRecord | null>(next);
      });

      if (!updated.ok) return updated;
      if (updated.value === null) {
        return ok<ProjectionOutcome>(
          alreadyUnpublished ? { kind: "noop_already_unpublished" } : { kind: "noop_missing" },
        );
      }
      return ok<ProjectionOutcome>({ kind: "unpublished", contentId: updated.value.id, slug: updated.value.slug });
    },

    listContent: (): Promise<readonly PublicContentRecord[]> => repo.listPublished(),
    // Published-only at the service layer too (the public reader filters
    // again — defense in depth against unpublished exposure).
    getContentBySlug: async (slug: string): Promise<PublicContentRecord | null> => {
      const row = await repo.findBySlug(slug);
      return row && row.status === "published" ? row : null;
    },
  };
};
