/**
 * People-domain service (Stage 2.16, D2.16-1..D2.16-8).
 *
 * Chain authoring + publication-authored snapshot family.
 * Every command:
 *  - derives authority from the server-derived Control principal
 *    (operatorId + orgId + capabilities resolved by identity — never a
 *    client body field);
 *  - gates via the people.manage / people.read capability family
 *    (D2.16-4 — NOT production.publish);
 *  - validates chain parents server-side: existence, SAME-ORG, acceptable
 *    lifecycle state (frozen invariant 5 — broken chains fail closed);
 *  - never throws for domain failures (discriminated results).
 *
 * D2.16-2: the optional Rights port is DECLARED here but left UNWIRED — when
 * `deps.rights` is absent every authoring decision is a vacuous pass. A
 * future Rights stage may inject a resolver; declared-but-unmet verdicts
 * FAIL CLOSED. No Rights tables/records exist in this stage.
 *
 * D2.16-3: `upsertProfileSnapshot` is the ONLY profile write path
 * (publication-mediated; idempotent by publication_version_id; republish
 * retires the previous current row to 'unpublished' and activates the new
 * row; history is never deleted). `unpublishCurrentSnapshot` is idempotent.
 */
import { err, ok, HANDLE_RE, AI_CREATOR_STATUSES, CHAIN_STATUSES, PEOPLE_AUDIT_ACTIONS, SYSTEM_ACTOR_ID } from "./types";
import type {
  AiCreatorStatus,
  ChainStatus,
  CreateAiCreatorInput,
  CreateCharacterInput,
  CreateDigitalHumanInput,
  CreatePersonaInput,
  CreatorFollowPort,
  CreatorSubjectPort,
  PeopleAggregateKind,
  PeoplePrincipal,
  PeopleRepository,
  PeopleResult,
  PeopleRightsPort,
  PeopleService,
  PeopleServiceDeps,
  PeopleTransaction,
  ProfileSnapshotInput,
  SnapshotOutcome,
  StatusChangeInput,
} from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? 50, 1), 200);

/** draft → active → retired (retired terminal; all else invalid). */
const validChainTransition = (from: ChainStatus, to: ChainStatus): boolean =>
  (from === "draft" && to === "active") ||
  (from === "active" && to === "retired") ||
  (from === "draft" && to === "retired");

/**
 * AI Creator lifecycle (DM §32.11, authorized freeze fix 1):
 * draft → active ⇄ paused → retired. No draft → paused, no draft → retired,
 * retired is terminal. digital_humans/characters/personas keep the shared
 * chain table above — unchanged.
 */
const validAiCreatorTransition = (from: AiCreatorStatus, to: AiCreatorStatus): boolean =>
  (from === "draft" && to === "active") ||
  (from === "active" && to === "paused") ||
  (from === "paused" && to === "active") ||
  (from === "active" && to === "retired") ||
  (from === "paused" && to === "retired");

/**
 * D2.16-2 Rights seam: resolve the verdict with a vacuous pass when the port
 * is unwired (absence of declared requirements = pass). A wired port that
 * declares requirements which are NOT met fails closed.
 */
const rightsPass = async (
  rights: PeopleRightsPort | undefined,
  input: { orgId: string; subjectKind: "digital_human" | "character" | "persona" | "ai_creator"; subjectId: string },
): Promise<PeopleResult<void>> => {
  if (!rights) return ok(undefined); // UNWIRED → vacuous pass (D2.16-2)
  const verdict = await rights.resolveRights(input);
  if (verdict.declared && !verdict.met) {
    return err("unauthorized", "rights requirements declared for this subject are unmet");
  }
  return ok(undefined);
};

const manageGate = (principal: PeoplePrincipal): PeopleResult<void> =>
  principal.capabilities.includes("people.manage")
    ? ok(undefined)
    : err("unauthorized", "people.manage capability required");

const readGate = (principal: PeoplePrincipal): PeopleResult<void> =>
  principal.capabilities.includes("people.read")
    ? ok(undefined)
    : err("unauthorized", "people.read capability required");

/**
 * D2.4-1 (reused): prefer the transactional path so a security-critical
 * mutation can never commit without its audit record; the sequential
 * fallback (no runInTransaction) mirrors production-engine and is test-only.
 */
const inTx = async <T>(repo: PeopleRepository, work: (tx: PeopleTransaction) => Promise<T>): Promise<T> => {
  if (repo.runInTransaction) return repo.runInTransaction(work);
  throw new Error(
    "people repository does not support transactions; audited mutations require runInTransaction (D2.4-1)",
  );
};

export const createPeopleService = (deps: PeopleServiceDeps): PeopleService => {
  const repo = deps.repository;
  const rights = deps.rights; // D2.16-2: intentionally UNWIRED in production

  // -------------------------------------------------------------------------
  // Chain integrity helpers (frozen invariant 5)
  // -------------------------------------------------------------------------

  /** Parent must exist AND belong to the caller's org (cross-org fails closed). */
  const requireSameOrgParent = async <T extends { id: string; orgId: string; status: ChainStatus }>(
    find: () => Promise<T | null>,
    expectedOrgId: string,
    inactiveReason: string,
  ): Promise<PeopleResult<T>> => {
    const parent = await find();
    if (!parent) return err("not_found", inactiveReason);
    if (parent.orgId !== expectedOrgId) return err("cross_org_reference", "parent belongs to a different organization");
    return ok(parent);
  };

  return {
    // -----------------------------------------------------------------------
    // Control authoring (people.manage)
    // -----------------------------------------------------------------------
    async createDigitalHuman(principal, input: CreateDigitalHumanInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const name = (input.name ?? "").trim();
      if (name.length < 1 || name.length > 200) return err("invalid_input", "name must be 1..200 characters");

      const rightsVerdict = await rightsPass(rights, {
        orgId: principal.orgId,
        subjectKind: "digital_human",
        subjectId: "new",
      });
      if (!rightsVerdict.ok) return rightsVerdict;

      const row = await inTx(repo, async (tx) => {
        const created = await tx.insertDigitalHuman({
          orgId: principal.orgId, // server-derived organization — never client-supplied
          name,
          appearanceRefs: input.appearanceRefs ?? [],
          baseModelVersionRef: input.baseModelVersionRef ?? null,
          baseWorkflowVersionRef: input.baseWorkflowVersionRef ?? null,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: PEOPLE_AUDIT_ACTIONS[0],
          targetType: "digital_human",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { name },
        });
        return created;
      });
      return ok(row);
    },

    async createCharacter(principal, input: CreateCharacterInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const name = (input.name ?? "").trim();
      if (name.length < 1 || name.length > 200) return err("invalid_input", "name must be 1..200 characters");

      let digitalHumanId: string | null = null;
      if (input.digitalHumanId) {
        if (!UUID_RE.test(input.digitalHumanId)) return err("invalid_input", "digitalHumanId must be a valid uuid");
        const parent = await requireSameOrgParent(
          () => repo.findDigitalHumanById(input.digitalHumanId as string),
          principal.orgId,
          "digital human does not exist",
        );
        if (!parent.ok) return parent;
        // Chain integrity: an unretired parent keeps the chain forgeable.
        if (parent.value.status === "retired") return err("inactive_parent", "digital human is retired");
        digitalHumanId = parent.value.id;
      }

      const rightsVerdict = await rightsPass(rights, {
        orgId: principal.orgId,
        subjectKind: "character",
        subjectId: digitalHumanId ?? "new",
      });
      if (!rightsVerdict.ok) return rightsVerdict;

      const row = await inTx(repo, async (tx) => {
        const created = await tx.insertCharacter({
          orgId: principal.orgId,
          digitalHumanId,
          name,
          bio: input.bio ?? null,
          visualRefs: input.visualRefs ?? [],
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: PEOPLE_AUDIT_ACTIONS[2],
          targetType: "character",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { name, digitalHumanId },
        });
        return created;
      });
      return ok(row);
    },

    async createPersona(principal, input: CreatePersonaInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const name = (input.name ?? "").trim();
      if (name.length < 1 || name.length > 200) return err("invalid_input", "name must be 1..200 characters");
      if (!UUID_RE.test(input.characterId)) return err("invalid_input", "characterId must be a valid uuid");

      const parent = await requireSameOrgParent(
        () => repo.findCharacterById(input.characterId),
        principal.orgId,
        "character does not exist",
      );
      if (!parent.ok) return parent;
      if (parent.value.status === "retired") return err("inactive_parent", "character is retired");

      const rightsVerdict = await rightsPass(rights, {
        orgId: principal.orgId,
        subjectKind: "persona",
        subjectId: parent.value.id,
      });
      if (!rightsVerdict.ok) return rightsVerdict;

      const row = await inTx(repo, async (tx) => {
        const created = await tx.insertPersona({
          orgId: principal.orgId,
          characterId: parent.value.id,
          name,
          personality: input.personality ?? null,
          interests: input.interests ?? [],
          capabilities: input.capabilities ?? [],
          languages: input.languages ?? [],
          behaviorConfig: input.behaviorConfig ?? {},
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: PEOPLE_AUDIT_ACTIONS[4],
          targetType: "persona",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { name, characterId: parent.value.id },
        });
        return created;
      });
      return ok(row);
    },

    async createAiCreator(principal, input: CreateAiCreatorInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const handle = (input.handle ?? "").trim();
      if (!HANDLE_RE.test(handle)) return err("invalid_handle", "handle must match ^[a-z0-9-]{3,64}$");
      const displayName = (input.displayName ?? "").trim();
      if (displayName.length < 1 || displayName.length > 200)
        return err("invalid_input", "displayName must be 1..200 characters");
      if (!UUID_RE.test(input.personaId)) return err("invalid_input", "personaId must be a valid uuid");

      // Duplicate handle within the org fails closed BEFORE the chain walk.
      const existing = await repo.findAiCreatorByHandle(principal.orgId, handle);
      if (existing) return err("invalid_handle", "handle already exists in this organization");

      const parent = await requireSameOrgParent(
        () => repo.findPersonaById(input.personaId),
        principal.orgId,
        "persona does not exist",
      );
      if (!parent.ok) return parent;
      if (parent.value.status === "retired") return err("inactive_parent", "persona is retired");

      const rightsVerdict = await rightsPass(rights, {
        orgId: principal.orgId,
        subjectKind: "ai_creator",
        subjectId: parent.value.id,
      });
      if (!rightsVerdict.ok) return rightsVerdict;

      const row = await inTx(repo, async (tx) => {
        const created = await tx.insertAiCreator({
          orgId: principal.orgId,
          personaId: parent.value.id,
          handle,
          displayName,
          capabilities: input.capabilities ?? [],
          contentCategories: input.contentCategories ?? [],
          communicationConfig: input.communicationConfig ?? {},
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: PEOPLE_AUDIT_ACTIONS[6],
          targetType: "ai_creator",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { handle, displayName, personaId: parent.value.id },
        });
        return created;
      });
      return ok(row);
    },

    async changeStatus(principal, kind: PeopleAggregateKind, input: StatusChangeInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(input.id)) return err("invalid_input", "id must be a valid uuid");
      // Per-kind status vocabulary: paused exists ONLY on ai_creator.
      const allowedStatuses = kind === "ai_creator" ? AI_CREATOR_STATUSES : CHAIN_STATUSES;
      if (!(allowedStatuses as readonly string[]).includes(input.status))
        return err("invalid_status_transition", `status ${input.status} is not valid for ${kind}`);

      const rightsVerdict = await rightsPass(rights, {
        orgId: principal.orgId,
        subjectKind: kind === "ai_creator" ? "ai_creator" : kind,
        subjectId: input.id,
      });
      if (!rightsVerdict.ok) return rightsVerdict;

      const apply = async <T extends { id: string; orgId: string; status: ChainStatus | AiCreatorStatus }>(
        kindAuditAction: (typeof PEOPLE_AUDIT_ACTIONS)[number],
        targetType: "digital_human" | "character" | "persona" | "ai_creator",
        find: (tx: PeopleTransaction) => Promise<T | null>,
        set: (tx: PeopleTransaction, id: string, status: ChainStatus | AiCreatorStatus) => Promise<T | null>,
      ): Promise<PeopleResult<T>> => {
        return inTx(repo, async (tx) => {
          const current = await find(tx);
          if (!current) return err("not_found", "aggregate does not exist");
          if (current.orgId !== principal.orgId) return err("not_found", "aggregate does not exist");
          const transitionOk =
            kind === "ai_creator"
              ? validAiCreatorTransition(current.status as AiCreatorStatus, input.status as AiCreatorStatus)
              : validChainTransition(current.status as ChainStatus, input.status as ChainStatus);
          if (!transitionOk) {
            return err(
              "invalid_status_transition",
              `cannot transition ${kind} from ${current.status} to ${input.status}`,
            );
          }
          const updated = await set(tx, input.id, input.status);
          if (!updated) return err("not_found", "aggregate disappeared");
          await tx.appendAudit({
            actorId: principal.operatorId,
            action: kindAuditAction,
            targetType,
            targetId: input.id,
            organizationId: principal.orgId,
            metadata: { from: current.status, to: input.status },
          });
          return ok(updated);
        });
      };

      switch (kind) {
        case "digital_human":
          return apply(
            PEOPLE_AUDIT_ACTIONS[1],
            "digital_human",
            (tx) => tx.findDigitalHumanById(input.id),
            // Casts safe: the per-kind status gate above rejects "paused" for
            // the shared chain aggregates.
            (tx, id, s) => tx.setDigitalHumanStatus(id, s as ChainStatus),
          );
        case "character":
          return apply(
            PEOPLE_AUDIT_ACTIONS[3],
            "character",
            (tx) => tx.findCharacterById(input.id),
            (tx, id, s) => tx.setCharacterStatus(id, s as ChainStatus),
          );
        case "persona":
          return apply(
            PEOPLE_AUDIT_ACTIONS[5],
            "persona",
            (tx) => tx.findPersonaById(input.id),
            (tx, id, s) => tx.setPersonaStatus(id, s as ChainStatus),
          );
        case "ai_creator":
          return apply(
            PEOPLE_AUDIT_ACTIONS[7],
            "ai_creator",
            (tx) => tx.findAiCreatorById(input.id),
            (tx, id, s) => tx.setAiCreatorStatus(id, s),
          );
      }
    },

    // -----------------------------------------------------------------------
    // Reads (people.read) — organization-scoped (except the public profile
    // list, which exposes only active PUBLIC rows through the Media seam)
    // -----------------------------------------------------------------------
    async listDigitalHumans(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listDigitalHumans(principal.orgId, clampLimit(limit)));
    },
    async listCharacters(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listCharacters(principal.orgId, clampLimit(limit)));
    },
    async listPersonas(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listPersonas(principal.orgId, clampLimit(limit)));
    },
    async listAiCreators(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listAiCreators(principal.orgId, clampLimit(limit)));
    },
    async listProfiles(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listProfilesByOrg(principal.orgId, clampLimit(limit)));
    },

    // -----------------------------------------------------------------------
    // Publication-authored snapshot family (D2.16-3)
    // -----------------------------------------------------------------------
    async upsertProfileSnapshot(input: ProfileSnapshotInput) {
      // Server-side mediation contract: the Control composition root derives
      // EVERY field from the durable publication record. Defensive re-checks
      // here keep the invariant even if a future caller regresses.
      if (!UUID_RE.test(input.aiCreatorId) || !UUID_RE.test(input.publicationId) || !UUID_RE.test(input.publicationVersionId)) {
        return err("invalid_input", "snapshot identifiers must be valid uuids");
      }
      if (!HANDLE_RE.test(input.handle)) return err("invalid_handle", "snapshot handle must match ^[a-z0-9-]{3,64}$");

      // IDEMPOTENCY by publication_version_id (frozen invariant 2).
      const existing = await repo.findProfileByVersionId(input.publicationVersionId);
      if (existing) {
        return ok<SnapshotOutcome>({ kind: "replayed", profileId: existing.id, publicationVersionId: input.publicationVersionId });
      }

      // Mediation invariant (security-freeze fix): creator existence, SAME-ORG
      // ownership, and ACTIVE status are re-checked INSIDE the transaction that
      // authors the snapshot — no TOCTOU window between gate and write, and the
      // invariant holds even if the creator is retired/paused between approve
      // and publish.
      const outcome = await inTx(repo, async (tx) => {
        // Re-check idempotency inside the transaction (UNIQUE backstops anyway).
        const dup = await tx.findProfileByVersionId(input.publicationVersionId);
        if (dup) return { tag: "replayed" as const, profileId: dup.id };
        // 1) creator exists · 2) same org · 3) status = active — fail closed.
        const creator = await tx.findAiCreatorById(input.aiCreatorId);
        if (!creator) return { tag: "error" as const, reason: "not_found" as const, message: "ai creator does not exist" };
        if (creator.orgId !== input.orgId)
          return { tag: "error" as const, reason: "cross_org_reference" as const, message: "ai creator belongs to a different organization" };
        if (creator.status !== "active")
          return { tag: "error" as const, reason: "inactive_parent" as const, message: `ai creator must be active for snapshot authoring (status: ${creator.status})` };
        // 4) publication + version must exist AND belong to the mediation org
        //    (freeze fix 2 — the anti-spoofing backstop for the derived org).
        const pubOrg = await tx.findPublicationVersionOrg(input.publicationId, input.publicationVersionId);
        if (!pubOrg) return { tag: "error" as const, reason: "not_found" as const, message: "publication version does not exist" };
        if (pubOrg.publicationOrgId !== input.orgId || pubOrg.versionOrgId !== input.orgId)
          return { tag: "error" as const, reason: "cross_org_reference" as const, message: "publication/version belongs to a different organization" };
        // Retire-and-activate in ONE transaction (D2.4-1): the previous current
        // snapshot flips to 'unpublished' and the new row activates together
        // with its audit record; a rollback removes both.
        const previous = await tx.findCurrentProfile(input.orgId, input.aiCreatorId);
        if (previous && previous.status !== "unpublished") await tx.retireProfile(previous.id);
        const created = await tx.insertProfile({
          orgId: input.orgId,
          aiCreatorId: input.aiCreatorId,
          publicationId: input.publicationId,
          publicationVersionId: input.publicationVersionId,
          handle: input.handle,
          displayName: input.displayName,
          bio: input.bio,
          personalitySnapshot: input.personalitySnapshot,
          interestsSnapshot: input.interestsSnapshot,
          avatarRef: input.avatarRef,
          posterRef: input.posterRef,
          messagingEnabled: input.messagingEnabled,
        });
        await tx.appendAudit({
          actorId: SYSTEM_ACTOR_ID,
          action: PEOPLE_AUDIT_ACTIONS[8],
          targetType: "creator_profile",
          targetId: created.id,
          organizationId: input.orgId,
          correlationId: input.publicationId,
          causationId: input.publicationVersionId,
          metadata: { handle: input.handle, publicationVersionId: input.publicationVersionId },
        });
        return { tag: "created" as const, row: created };
      });
      if (outcome.tag === "replayed") {
        return ok<SnapshotOutcome>({ kind: "replayed", profileId: outcome.profileId, publicationVersionId: input.publicationVersionId });
      }
      if (outcome.tag === "error") return err(outcome.reason, outcome.message);
      return ok<SnapshotOutcome>({ kind: "created", profileId: outcome.row.id, publicationVersionId: input.publicationVersionId });
    },

    async unpublishCurrentSnapshot(input: { orgId: string; aiCreatorId: string }) {
      if (!UUID_RE.test(input.aiCreatorId)) return err("invalid_input", "aiCreatorId must be a valid uuid");
      const current = await repo.findCurrentProfile(input.orgId, input.aiCreatorId);
      if (!current) return ok({ kind: "absent" }); // idempotent no-op, no audit
      if (current.status === "unpublished") return ok({ kind: "retired" }); // idempotent re-call
      await inTx(repo, async (tx) => {
        const retired = await tx.retireProfile(current.id);
        await tx.appendAudit({
          actorId: SYSTEM_ACTOR_ID,
          action: PEOPLE_AUDIT_ACTIONS[9],
          targetType: "creator_profile",
          targetId: retired.id,
          organizationId: input.orgId,
          metadata: { handle: retired.handle },
        });
      });
      return ok({ kind: "retired" });
    },
  };
};

// Re-exported narrow seams (D2.16-5 / D2.16-6) for composition roots.
export type { CreatorFollowPort, CreatorSubjectPort };
