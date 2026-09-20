/**
 * Narrow read-only seams over the People repository (Stage 2.16).
 *
 * D2.16-5 (Social): `createCreatorFollowPort` resolves an ACTIVE creator
 * profile by id — the ONLY new dependency Social gains. It returns the
 * minimal same-org facts; Social never sees chain internals.
 *
 * D2.16-6 (Publishing): `createCreatorSubjectPort` resolves the
 * ai_creator_profile subject: the creator must be ACTIVE and carry a live
 * (status = active) current profile in the SAME organization. Fail-closed
 * otherwise.
 *
 * Both ports are strictly READ-ONLY — no mutation capability is exposed, and
 * neither seam can create People rows.
 */
import type { Database } from "@stratifit/database";
import { and, eq } from "drizzle-orm";
import { aiCreators, creatorProfiles } from "@stratifit/database";
import type { CreatorFollowPort, CreatorSubjectPort } from "./types";

export const createCreatorFollowPort = (deps: { db: Database }): CreatorFollowPort => ({
  findActiveProfileById: async (profileId) => {
    const [row] = await deps.db
      .select({
        id: creatorProfiles.id,
        orgId: creatorProfiles.orgId,
        handle: creatorProfiles.handle,
      })
      .from(creatorProfiles)
      .where(and(eq(creatorProfiles.id, profileId), eq(creatorProfiles.status, "active")))
      .limit(1);
    return row ?? null;
  },
});

export const createCreatorSubjectPort = (deps: { db: Database }): CreatorSubjectPort => ({
  resolveActiveSubject: async (orgId, aiCreatorId) => {
    const [row] = await deps.db
      .select({
        aiCreatorId: aiCreators.id,
        orgId: aiCreators.orgId,
        handle: aiCreators.handle,
        profileId: creatorProfiles.id,
      })
      .from(aiCreators)
      .innerJoin(
        creatorProfiles,
        and(eq(creatorProfiles.aiCreatorId, aiCreators.id), eq(creatorProfiles.orgId, aiCreators.orgId)),
      )
      .where(
        and(
          eq(aiCreators.id, aiCreatorId),
          eq(aiCreators.orgId, orgId),
          eq(aiCreators.status, "active"),
          eq(creatorProfiles.status, "active"),
        ),
      )
      .limit(1);
    return row ? { ...row, profileStatus: "active" as const } : null;
  },
});
