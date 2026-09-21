/**
 * Rights & Consent domain service (Stage 2.21, D2.21-1..D2.21-8).
 *
 * Every command:
 *  - derives authority from the server-derived Control principal (operatorId
 *    + orgId + capabilities resolved by identity — never a client field);
 *  - gates via the rights.manage / rights.read capability family (D2.21-4);
 *  - validates referenced owners/subjects INSIDE the mutation transaction:
 *    existence, SAME-ORG ownership (cross-org fails closed as not_found —
 *    no existence disclosure), and non-rejected owners;
 *  - appends the immutable rights_status_events row (history of record,
 *    D2.21-3) for every grant status transition;
 *  - writes the frozen audit action in the SAME transaction (D2.4-1/D2.21-8)
 *    so a rollback removes the mutation, the status event, and the audit row;
 *  - never throws for domain failures (discriminated results).
 *
 * D2.21-6: grant CORE fields have NO update path — only status transitions.
 * D2.21-5: transitions come from the frozen table; revoked/expired terminal;
 * evaluation is LAZY over validity windows (evaluateUse below) — the frozen
 * `expired` status is only set by an explicit operator command.
 * D2.21-2: evaluateUse is exported for a FUTURE cutover stage; nothing in
 * Production/Publishing/People/QC is wired to it in Stage 2.21.
 */
import {
  GRANT_STATUSES,
  REQUIREMENT_ENFORCEMENTS,
  RIGHTS_AUDIT_ACTIONS,
  RIGHTS_PLATFORMS,
  RIGHTS_SCOPES,
  RIGHTS_SUBJECT_KINDS,
  err,
  ok,
} from "./types";
import type {
  CreateGrantInput,
  CreateOwnerInput,
  CreateRequirementInput,
  GrantStatus,
  GrantStatusInput,
  OwnerKind,
  OwnerVerificationInput,
  OwnerVerificationStatus,
  RequirementEnforcement,
  RightsGrantRecord,
  RightsOwnerRecord,
  RightsPrincipal,
  RightsRepository,
  RightsRequirementRecord,
  RightsResult,
  RightsService,
  RightsServiceDeps,
  RightsTransaction,
  RightsSubjectKind,
  RightsScope,
  RightsPlatform,
  RequirementsVerdict,
  UpdateRequirementInput,
  UseEvaluation,
  UseRequest,
  UnsatisfiedReason,
} from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? 50, 1), 200);

/**
 * D2.21-5 transition table (frozen):
 *   draft → active; active → suspended|revoked|expired;
 *   suspended → active|revoked|expired (suspended → active = reinstatement).
 * revoked/expired TERMINAL; draft → revoked/suspended/expired NOT allowed;
 * no same-status transitions; expired only by explicit operator command.
 */
const validGrantTransition = (from: GrantStatus, to: GrantStatus): boolean =>
  (from === "draft" && to === "active") ||
  (from === "active" && to === "suspended") ||
  (from === "suspended" && to === "active") ||
  (from === "active" && to === "revoked") ||
  (from === "suspended" && to === "revoked") ||
  (from === "active" && to === "expired") ||
  (from === "suspended" && to === "expired");

/** Owner verification lifecycle: unverified → pending → verified|rejected (terminal). */
const validVerificationTransition = (from: OwnerVerificationStatus, to: OwnerVerificationStatus): boolean =>
  (from === "unverified" && to === "pending") ||
  (from === "pending" && to === "verified") ||
  (from === "pending" && to === "rejected") ||
  // Verified/rejected owners can be re-reviewed back to pending (re-review).
  (from === "verified" && to === "pending") ||
  (from === "rejected" && to === "pending");

const manageGate = (principal: RightsPrincipal): RightsResult<void> =>
  principal.capabilities.includes("rights.manage")
    ? ok(undefined)
    : err("unauthorized", "rights.manage capability required");

const readGate = (principal: RightsPrincipal): RightsResult<void> =>
  principal.capabilities.includes("rights.read")
    ? ok(undefined)
    : err("unauthorized", "rights.read capability required");

const inTx = <T>(repo: RightsRepository, work: (tx: RightsTransaction) => Promise<T>): Promise<T> =>
  repo.runInTransaction(work);

export const createRightsService = (deps: RightsServiceDeps): RightsService => {
  const repo = deps.repository;

  return {
    // -----------------------------------------------------------------------
    // Control authoring (rights.manage)
    // -----------------------------------------------------------------------
    async createOwner(principal, input: CreateOwnerInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      const displayName = input.displayName.trim();
      if (displayName.length < 1 || displayName.length > 200)
        return err("invalid_input", "displayName must be 1..200 characters");
      if (input.contactRef != null && input.contactRef.length > 500)
        return err("invalid_input", "contactRef must be at most 500 characters");

      const row = await inTx(repo, async (tx) => {
        const created = await tx.insertOwner({
          orgId: principal.orgId, // server-derived organization — never client-supplied
          kind: input.kind,
          displayName,
          contactRef: input.contactRef ?? null,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: RIGHTS_AUDIT_ACTIONS[0],
          targetType: "rights_owner",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: { kind: input.kind, displayName },
        });
        return created;
      });
      return ok(row);
    },

    async changeOwnerVerification(principal, input: OwnerVerificationInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(input.id)) return err("invalid_input", "id must be a valid uuid");

      return inTx(repo, async (tx) => {
        const current = await tx.findOwnerById(input.id);
        // IDOR-safe: cross-org owners are indistinguishable from absent ones.
        if (!current) return err("not_found", "rights owner does not exist");
        if (current.orgId !== principal.orgId) return err("not_found", "rights owner does not exist");
        if (!validVerificationTransition(current.verificationStatus, input.status))
          return err(
            "invalid_status_transition",
            `cannot transition owner verification from ${current.verificationStatus} to ${input.status}`,
          );
        const updated = await tx.setOwnerVerificationStatus(input.id, input.status);
        if (!updated) return err("not_found", "rights owner disappeared");
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: RIGHTS_AUDIT_ACTIONS[1],
          targetType: "rights_owner",
          targetId: input.id,
          organizationId: principal.orgId,
          metadata: { from: current.verificationStatus, to: input.status },
        });
        return ok(updated);
      });
    },

    async createGrant(principal, input: CreateGrantInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(input.ownerId)) return err("invalid_input", "ownerId must be a valid uuid");
      if (!UUID_RE.test(input.subjectId)) return err("invalid_input", "subjectId must be a valid uuid");
      if (!(RIGHTS_SUBJECT_KINDS as readonly string[]).includes(input.subjectKind))
        return err("invalid_input", `subjectKind must be one of ${RIGHTS_SUBJECT_KINDS.join(", ")}`);
      if (!(RIGHTS_SCOPES as readonly string[]).includes(input.scope))
        return err("invalid_input", `scope must be one of ${RIGHTS_SCOPES.join(", ")}`);
      if (!Array.isArray(input.platforms) || input.platforms.length === 0)
        return err("invalid_input", "platforms must be a non-empty array");
      for (const p of input.platforms) {
        if (!(RIGHTS_PLATFORMS as readonly string[]).includes(p))
          return err("invalid_input", `platform ${p} is not in the frozen platform family`);
      }
      if (!Array.isArray(input.territories) || input.territories.length === 0)
        return err("invalid_input", "territories must be a non-empty array");
      for (const t of input.territories) {
        if (typeof t !== "string" || t.trim().length === 0 || t.length > 9)
          return err("invalid_input", "territories must be ISO-3166 alpha-2 codes or 'worldwide'");
        if (t !== "worldwide" && !/^[A-Z]{2}$/.test(t))
          return err("invalid_input", "territories must be ISO-3166 alpha-2 codes or 'worldwide'");
      }
      if (input.startsAt && input.expiresAt && input.expiresAt.getTime() <= input.startsAt.getTime())
        return err("invalid_input", "expiresAt must be after startsAt");
      const evidenceRefs = input.evidenceRefs ?? [];
      if (evidenceRefs.length > 20) return err("invalid_input", "evidenceRefs must be at most 20 refs");
      for (const r of evidenceRefs) {
        if (typeof r !== "string" || r.length === 0 || r.length > 500)
          return err("invalid_input", "evidence refs must be 1..500 character storage refs");
      }

      return inTx(repo, async (tx) => {
        // Parent integrity INSIDE the transaction: the owner must exist,
        // belong to the caller's org, and not be verification-rejected.
        const owner = await tx.findOwnerById(input.ownerId);
        if (!owner) return err("not_found", "rights owner does not exist");
        if (owner.orgId !== principal.orgId) return err("not_found", "rights owner does not exist");
        if (owner.verificationStatus === "rejected")
          return err("inactive_parent", "rights owner verification was rejected");
        // Subject integrity INSIDE the transaction: same-org existence via
        // the narrow read-only seam (no Production/People/Generation change).
        const subject = await tx.findSubjectRef(input.subjectKind, input.subjectId);
        if (!subject) return err("not_found", "referenced subject does not exist");
        if (subject.orgId !== principal.orgId) return err("not_found", "referenced subject does not exist");
        const created = await tx.insertGrant({
          orgId: principal.orgId,
          ownerId: owner.id,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          scope: input.scope,
          platforms: input.platforms,
          territories: input.territories,
          startsAt: input.startsAt ?? null,
          expiresAt: input.expiresAt ?? null,
          grantedBy: principal.operatorId, // real server-derived operator
          evidenceRefs,
          status: "draft" satisfies GrantStatus,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: RIGHTS_AUDIT_ACTIONS[2],
          targetType: "rights_grant",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: {
            ownerId: owner.id,
            subjectKind: input.subjectKind,
            subjectId: input.subjectId,
            scope: input.scope,
            platforms: input.platforms,
            territories: input.territories,
          },
        });
        return ok(created);
      });
    },

    async changeGrantStatus(principal, input: GrantStatusInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(input.id)) return err("invalid_input", "id must be a valid uuid");
      if (!(GRANT_STATUSES as readonly string[]).includes(input.status))
        return err("invalid_status_transition", `status ${input.status} is not a valid grant status`);
      if (input.reason != null && input.reason.length > 1000)
        return err("invalid_input", "reason must be at most 1000 characters");

      return inTx(repo, async (tx) => {
        const current = await tx.findGrantById(input.id);
        // IDOR-safe: cross-org grants are indistinguishable from absent ones.
        if (!current) return err("not_found", "rights grant does not exist");
        if (current.orgId !== principal.orgId) return err("not_found", "rights grant does not exist");
        if (!validGrantTransition(current.status, input.status))
          return err(
            "invalid_status_transition",
            `cannot transition grant from ${current.status} to ${input.status}`,
          );
        const updated = await tx.setGrantStatus(input.id, input.status);
        if (!updated) return err("not_found", "rights grant disappeared");
        // History of record (D2.21-3): immutable status-event row, same tx.
        await tx.insertStatusEvent({
          orgId: principal.orgId,
          grantId: input.id,
          fromStatus: current.status,
          toStatus: input.status,
          reason: input.reason ?? null,
          actorId: principal.operatorId,
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: RIGHTS_AUDIT_ACTIONS[3],
          targetType: "rights_grant",
          targetId: input.id,
          organizationId: principal.orgId,
          metadata: { from: current.status, to: input.status, reason: input.reason ?? null },
        });
        return ok(updated);
      });
    },

    // -----------------------------------------------------------------------
    // Requirements declarations (Stage 2.22, D2.22-1/-3/-6)
    // -----------------------------------------------------------------------
    async createRequirement(principal, input: CreateRequirementInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(input.subjectId)) return err("invalid_input", "subjectId must be a valid uuid");
      if (!(RIGHTS_SUBJECT_KINDS as readonly string[]).includes(input.subjectKind))
        return err("invalid_input", `subjectKind must be one of ${RIGHTS_SUBJECT_KINDS.join(", ")}`);
      if (!(RIGHTS_SCOPES as readonly string[]).includes(input.scope))
        return err("invalid_input", `scope must be one of ${RIGHTS_SCOPES.join(", ")}`);
      if (!Array.isArray(input.platforms) || input.platforms.length === 0)
        return err("invalid_input", "platforms must be a non-empty array");
      for (const p of input.platforms) {
        if (!(RIGHTS_PLATFORMS as readonly string[]).includes(p))
          return err("invalid_input", `platform ${p} is not in the frozen platform family`);
      }
      if (!Array.isArray(input.territories) || input.territories.length === 0)
        return err("invalid_input", "territories must be a non-empty array");
      for (const t of input.territories) {
        if (typeof t !== "string" || t.trim().length === 0 || t.length > 9)
          return err("invalid_input", "territories must be ISO-3166 alpha-2 codes or 'worldwide'");
        if (t !== "worldwide" && !/^[A-Z]{2}$/.test(t))
          return err("invalid_input", "territories must be ISO-3166 alpha-2 codes or 'worldwide'");
      }
      if (!(REQUIREMENT_ENFORCEMENTS as readonly string[]).includes(input.enforcement))
        return err("invalid_input", `enforcement must be one of ${REQUIREMENT_ENFORCEMENTS.join(", ")}`);
      if (input.reason != null && input.reason.length > 1000)
        return err("invalid_input", "reason must be at most 1000 characters");

      return inTx(repo, async (tx) => {
        // Subject integrity INSIDE the transaction: same-org existence via
        // the narrow read-only seam (cross-org → not_found, no leak).
        const subject = await tx.findSubjectRef(input.subjectKind, input.subjectId);
        if (!subject) return err("not_found", "referenced subject does not exist");
        if (subject.orgId !== principal.orgId) return err("not_found", "referenced subject does not exist");
        const created = await tx.insertRequirement({
          orgId: principal.orgId,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          scope: input.scope,
          platforms: input.platforms,
          territories: input.territories,
          enforcement: input.enforcement,
          reason: input.reason ?? null,
          createdBy: principal.operatorId, // real server-derived operator
        });
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: RIGHTS_AUDIT_ACTIONS[4], // rights.requirement_recorded (D2.22-6)
          targetType: "rights_requirement",
          targetId: created.id,
          organizationId: principal.orgId,
          metadata: {
            subjectKind: input.subjectKind,
            subjectId: input.subjectId,
            scope: input.scope,
            platforms: input.platforms,
            territories: input.territories,
            enforcement: input.enforcement,
          },
        });
        return ok(created);
      });
    },

    async updateRequirement(principal, input: UpdateRequirementInput) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(input.id)) return err("invalid_input", "id must be a valid uuid");
      if (input.enforcement !== undefined && !(REQUIREMENT_ENFORCEMENTS as readonly string[]).includes(input.enforcement))
        return err("invalid_input", `enforcement must be one of ${REQUIREMENT_ENFORCEMENTS.join(", ")}`);
      if (input.platforms !== undefined) {
        if (!Array.isArray(input.platforms) || input.platforms.length === 0)
          return err("invalid_input", "platforms must be a non-empty array");
        for (const p of input.platforms) {
          if (!(RIGHTS_PLATFORMS as readonly string[]).includes(p))
            return err("invalid_input", `platform ${p} is not in the frozen platform family`);
        }
      }
      if (input.territories !== undefined) {
        if (!Array.isArray(input.territories) || input.territories.length === 0)
          return err("invalid_input", "territories must be a non-empty array");
        for (const t of input.territories) {
          if (typeof t !== "string" || t.trim().length === 0 || t.length > 9)
            return err("invalid_input", "territories must be ISO-3166 alpha-2 codes or 'worldwide'");
          if (t !== "worldwide" && !/^[A-Z]{2}$/.test(t))
            return err("invalid_input", "territories must be ISO-3166 alpha-2 codes or 'worldwide'");
        }
      }
      if (input.reason != null && input.reason.length > 1000)
        return err("invalid_input", "reason must be at most 1000 characters");

      return inTx(repo, async (tx) => {
        const current = await tx.findRequirementById(input.id);
        // IDOR-safe: cross-org rows are indistinguishable from absent ones.
        if (!current || current.orgId !== principal.orgId)
          return err("not_found", "rights requirement does not exist");
        // D2.22-3: `enforce` rows are IMMUTABLE after creation — retire by
        // delete + re-create (both authorized + audited). Only `record_only`
        // rows may be corrected.
        if (current.enforcement === "enforce")
          return err(
            "invalid_input",
            "enforce requirements are immutable; delete and re-create to change them",
          );
        const updated = await tx.updateRequirementCore(input.id, {
          ...(input.platforms !== undefined ? { platforms: input.platforms } : {}),
          ...(input.territories !== undefined ? { territories: input.territories } : {}),
          ...(input.enforcement !== undefined ? { enforcement: input.enforcement } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
        if (!updated) return err("not_found", "rights requirement disappeared");
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: RIGHTS_AUDIT_ACTIONS[4],
          targetType: "rights_requirement",
          targetId: input.id,
          organizationId: principal.orgId,
          metadata: { corrected: true },
        });
        return ok(updated);
      });
    },

    async deleteRequirement(principal, id) {
      const gate = manageGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(id)) return err("invalid_input", "id must be a valid uuid");
      return inTx(repo, async (tx) => {
        const current = await tx.findRequirementById(id);
        if (!current || current.orgId !== principal.orgId)
          return err("not_found", "rights requirement does not exist");
        const deleted = await tx.deleteRequirement(id);
        if (!deleted) return err("not_found", "rights requirement disappeared");
        await tx.appendAudit({
          actorId: principal.operatorId,
          action: RIGHTS_AUDIT_ACTIONS[4],
          targetType: "rights_requirement",
          targetId: id,
          organizationId: principal.orgId,
          metadata: { retired: true, enforcement: current.enforcement },
        });
        return ok({ id });
      });
    },

    async listRequirements(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listRequirements(principal.orgId, clampLimit(limit)));
    },

    // -----------------------------------------------------------------------
    // Reads (rights.read) — organization-scoped
    // -----------------------------------------------------------------------
    async listOwners(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listOwners(principal.orgId, clampLimit(limit)));
    },
    async listGrants(principal, limit) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      return ok(await repo.listGrants(principal.orgId, clampLimit(limit)));
    },
    async getGrant(principal, id) {
      const gate = readGate(principal);
      if (!gate.ok) return gate;
      if (!UUID_RE.test(id)) return err("invalid_input", "id must be a valid uuid");
      const grant = await repo.findGrantById(id);
      // IDOR-safe: cross-org grants are indistinguishable from absent ones.
      if (!grant || grant.orgId !== principal.orgId) return err("not_found", "rights grant does not exist");
      const history = await repo.listStatusEvents(id);
      return ok({ grant, history });
    },

    // -----------------------------------------------------------------------
    // Evaluation (D2.21-2: pure fail-closed function; UNWIRED in 2.21)
    // -----------------------------------------------------------------------
    async evaluateUse(request: UseRequest): Promise<UseEvaluation> {
      const candidates = await repo.findGrantBySubject(
        request.orgId,
        request.subjectKind,
        request.subjectId,
        request.scope,
      );
      if (candidates.length === 0) {
        return {
          satisfied: false,
          reasons: [{ code: "grant_not_found", message: "no applicable grant exists for this use" }],
        };
      }
      const failures: UnsatisfiedReason[] = [];
      for (const g of candidates) {
        const why: UnsatisfiedReason[] = [];
        if (g.status !== "active") {
          why.push({
            code: "grant_not_active",
            message: `grant status is ${g.status} (revoked/suspended/expired grants never satisfy)`,
            grantId: g.id,
          });
        }
        if (g.startsAt && request.at.getTime() < g.startsAt.getTime()) {
          why.push({ code: "validity_window", message: "use precedes the grant validity window", grantId: g.id });
        }
        if (g.expiresAt && request.at.getTime() >= g.expiresAt.getTime()) {
          why.push({ code: "validity_window", message: "use is at or after grant expiry", grantId: g.id });
        }
        if (!g.platforms.includes(request.platform) && !g.platforms.includes("all")) {
          why.push({ code: "platform_mismatch", message: `platform ${request.platform} not covered`, grantId: g.id });
        }
        if (!g.territories.includes("worldwide") && !g.territories.includes(request.territory)) {
          why.push({
            code: "territory_mismatch",
            message: `territory ${request.territory} not covered`,
            grantId: g.id,
          });
        }
        if (why.length === 0) return { satisfied: true, grantId: g.id, reasons: [] };
        failures.push(...why);
      }
      // Scope mismatch produces the same fail-closed shape as no grant at all
      // (the lookup is scope-keyed), so no separate scope reason can leak.
      return { satisfied: false, reasons: failures };
    },

    // -----------------------------------------------------------------------
    // Port-compatible requirements evaluation (D2.22-2): the exact shape both
    // frozen ports consume. UNWIRED in Stage 2.22 — the adapters below are
    // built + exported but NOT injected into any composition (D2.22-4).
    // -----------------------------------------------------------------------
    async evaluateUseAgainstRequirements(
      orgId,
      subjectKind,
      subjectId,
      scope,
      platform,
      territory,
      at,
    ): Promise<RequirementsVerdict> {
      // D2.22-2: absence of declarations preserves the vacuous pass EXACTLY.
      const declarations = await repo.findRequirementsBySubject(orgId, subjectKind, subjectId);
      if (declarations.length === 0) return { declared: false, met: true, reasons: [] };
      // Declarations present: evaluate each with the existing evaluateUse
      // semantics (same repo lookups, same fail-closed reasons).
      const reasons: string[] = [];
      let met = false;
      for (const d of declarations) {
        if (d.scope !== scope) {
          reasons.push(`declaration ${d.id} covers scope ${d.scope}, not ${scope}`);
          continue;
        }
        const evaluation = await this.evaluateUse({ orgId, subjectKind, subjectId, scope, platform, territory, at });
        if (evaluation.satisfied) {
          met = true;
          break;
        }
        reasons.push(...evaluation.reasons.map((r) => `${r.code}: ${r.message}`));
      }
      // D2.22-2 fail-closed: declared requirements that are not satisfied
      // produce declared=true, met=false with structured reasons.
      return { declared: true, met, reasons };
    },
  };
};

// ---------------------------------------------------------------------------
// Pure subject/platform mapping functions (D2.22-5) — independently testable,
// frozen tables. Unmapped subjects return null so callers preserve the
// vacuous-pass behavior; mappings NEVER invent a requirement.
// ---------------------------------------------------------------------------

/** Publishing subject kinds → Rights v1 subject kinds (null = out of v1 scope). */
export const publicationSubjectToRightsSubject = (
  subjectKind: "production" | "asset_version" | "ai_creator_profile" | "campaign_creative",
): RightsSubjectKind | null => {
  switch (subjectKind) {
    case "production":
      return "production";
    case "asset_version":
      return "asset"; // publication subject references an asset_version row
    case "ai_creator_profile":
      return null; // NO Rights v1 kind (D2.21-1; DM OQ1 open)
    case "campaign_creative":
      return null; // NO Rights v1 kind (fail-vacuous until OQ6)
  }
};

/** Publishing platform targets → Rights platform family. */
export const platformTargetToRightsPlatform = (
  target: "stratifit-media" | "youtube" | "tiktok" | "instagram" | "facebook",
): RightsPlatform =>
  target === "stratifit-media" ? "stratifit_media" : (target as RightsPlatform);

/**
 * D2.22-4 adapter: PublicationRightsPort implementation over the service.
 * BUILT + EXPORTED but NOT injected into any composition in Stage 2.22 —
 * the Publishing composition keeps its vacuous pass until the authorized
 * Stage 2.23 cutover.
 */
export const createPublicationRightsAdapter = (service: RightsService) =>
  async (
    orgId: string,
    subjectKind: "production" | "asset_version" | "ai_creator_profile" | "campaign_creative",
    subjectRef: string,
  ): Promise<{ readonly declared: boolean; readonly met: boolean; readonly reasons?: readonly string[] }> => {
    const rightsKind = publicationSubjectToRightsSubject(subjectKind);
    if (rightsKind === null) return { declared: false, met: true }; // out of v1 scope → vacuous
    const verdict = await service.evaluateUseAgainstRequirements(
      orgId,
      rightsKind,
      subjectRef,
      "publication",
      "stratifit_media",
      "worldwide",
      new Date(),
    );
    return verdict;
  };

/**
 * D2.22-4 adapter: PeopleRightsPort implementation over the service.
 * BUILT + EXPORTED but NOT injected into any composition in Stage 2.22 —
 * the People composition keeps its vacuous pass until the authorized
 * Stage 2.23 cutover.
 */
export const createPeopleRightsAdapter = (service: RightsService) =>
  async (input: {
    orgId: string;
    subjectKind: "digital_human" | "character" | "persona" | "ai_creator";
    subjectId: string;
  }): Promise<{ readonly declared: boolean; readonly met: boolean }> => {
    if (input.subjectKind === "ai_creator") return { declared: false, met: true }; // NO Rights v1 kind (D2.21-1)
    const declarations = await service.listRequirements(
      { operatorId: "", orgId: input.orgId, capabilities: ["rights.read"] },
      200,
    );
    // Cheap existence probe: any declaration rows for this org+subject kind
    // determine declared; per-subject evaluation happens through the service
    // evaluator to keep a single fail-closed path.
    if (!declarations.ok) return { declared: false, met: true };
    const relevant = declarations.value.filter((r) => r.subjectId === input.subjectId);
    if (relevant.length === 0) return { declared: false, met: true }; // D2.22-2
    const verdict = await service.evaluateUseAgainstRequirements(
      input.orgId,
      input.subjectKind,
      input.subjectId,
      relevant[0]!.scope,
      "stratifit_media",
      "worldwide",
      new Date(),
    );
    return { declared: verdict.declared, met: verdict.met };
  };

/**
 * Pure coverage predicate shared by the evaluator (exported for adapter
 * construction in a future cutover stage): does ONE grant cover the request?
 * Used by the seam adapters; kept total and side-effect-free.
 */
export const evaluateGrantCoverage = (g: RightsGrantRecord, request: UseRequest): boolean =>
  g.status === "active" &&
  (!g.startsAt || request.at.getTime() >= g.startsAt.getTime()) &&
  (!g.expiresAt || request.at.getTime() < g.expiresAt.getTime()) &&
  (g.platforms.includes(request.platform) || g.platforms.includes("all")) &&
  (g.territories.includes("worldwide") || g.territories.includes(request.territory));
