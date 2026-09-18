/**
 * Asset domain service (Stage 2.10, approved decisions D2.10-1..D2.10-5).
 *
 * Operator-originated commands enforce, in order: capability
 * (`production.plan`, the API_ARCHITECTURE-sanctioned Assets capability) ->
 * org boundary -> deterministic validation -> state-machine validity ->
 * persistence -> post-commit event publication (Stage-1 semantics, existing
 * asset.* names + the D2.10-2 additive `asset.rejected`).
 *
 * D2.10-1: approval state lives on the MUTABLE assets aggregate; the
 * DM section 32.4 machine is pending -> in_review -> approved | rejected
 * with rejected -> pending recovery. `approved` is terminal for the current
 * version: registering a superseding version resets the aggregate to
 * `pending` ("a superseding version restarts the cycle") and moves the
 * current-version pointer. asset_versions/asset_lineage are NEVER updated.
 *
 * D2.10-4: registerAssetVersion is operator-context-conditional — audited
 * when called with an operator actor; the repository/transaction seam also
 * supports unauthenticated execution-path callers (no fake operator identity
 * is invented; those calls simply carry no audit entry).
 *
 * D2.4-1 (reused): actor-originated mutations and their audit records commit
 * inside the SAME database transaction via `AssetRepository.runInTransaction`
 * — repositories without transaction support fail closed unless the TEST-ONLY
 * `allowSequentialAudit` flag is set.
 *
 * D2.10-5: lineage reads are single-hop only; there is no traversal API.
 * Cycle defense follows the Stage 2.7 jobs precedent: edges are only created
 * alongside newly registered versions, so no cycle is constructible through
 * the service API (a brand-new version cannot be an ancestor of its parent);
 * the documented service checks are defense-in-depth.
 */
import { randomUUID } from "node:crypto";
import type { ControlCapability } from "@stratifit/permissions";
import { emitEvent, InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import type {
  AssetActor,
  AssetApprovalState,
  AssetAuditAppend,
  AssetCommandErrorReason,
  AssetCommandResult,
  AssetDerivationKind,
  AssetKind,
  AssetLineageRecord,
  AssetRecord,
  AssetRepository,
  AssetSubtype,
  AssetTransaction,
  AssetVersionRecord,
  RegisterAssetInput,
  RegisterAssetVersionInput,
  StorageRefInput,
} from "./types";
import { ASSET_APPROVAL_TRANSITIONS, ASSET_DERIVATION_KINDS, ASSET_KINDS, ASSET_SUBTYPES } from "./types";

export interface AssetServiceDeps {
  repository: AssetRepository;
  /** Defaults to an in-process publisher with no handlers (Stage-1 semantics). */
  publisher?: EventPublisher;
  /** Fallback audit seam (used only when the repository has no transaction support). */
  auditAppend?: AssetAuditAppend;
  /**
   * TEST-ONLY: permit the sequential (non-transactional) audit fallback for
   * repositories without `runInTransaction`. Production composition roots
   * never set it — there the service fail-closes instead (D2.4-1).
   */
  allowSequentialAudit?: boolean;
  eventIdFactory?: () => string;
}

export interface RegisterVersionOutcome {
  readonly version: AssetVersionRecord;
  readonly asset: AssetRecord;
  /** Set when the input requested a lineage edge to the new version. */
  readonly lineage?: AssetLineageRecord | null;
}

export interface AssetService {
  // ---- operator-originated (capability-gated, audited) ----
  registerAsset(actor: AssetActor, input: RegisterAssetInput): Promise<AssetCommandResult<AssetRecord>>;
  registerAssetVersion(
    actor: AssetActor | null,
    input: RegisterAssetVersionInput,
  ): Promise<AssetCommandResult<RegisterVersionOutcome>>;
  submitForReview(actor: AssetActor, assetId: string): Promise<AssetCommandResult<AssetRecord>>;
  approveAssetVersion(actor: AssetActor, assetId: string): Promise<AssetCommandResult<AssetRecord>>;
  rejectAssetVersion(actor: AssetActor, assetId: string, reason: string): Promise<AssetCommandResult<AssetRecord>>;

  // ---- org-scoped queries ----
  getAsset(actor: AssetActor, assetId: string): Promise<AssetCommandResult<AssetRecord>>;
  getAssetVersion(actor: AssetActor, versionId: string): Promise<AssetCommandResult<AssetVersionRecord>>;
  listAssetVersions(actor: AssetActor, assetId: string): Promise<AssetCommandResult<AssetVersionRecord[]>>;
  /** D2.10-5: single-hop lineage reads only. */
  getLineageParents(actor: AssetActor, versionId: string): Promise<AssetCommandResult<AssetLineageRecord[]>>;
  getLineageChildren(actor: AssetActor, versionId: string): Promise<AssetCommandResult<AssetLineageRecord[]>>;
  listAssets(actor: AssetActor, filter?: { kind?: AssetKind; approvalState?: AssetApprovalState }): Promise<AssetRecord[]>;
}

const ASSET_CAPABILITY: ControlCapability = "production.plan";

export const createAssetService = (deps: AssetServiceDeps): AssetService => {
  const repo = deps.repository;
  const publisher = deps.publisher ?? new InProcessEventPublisher();
  const fallbackAudit = deps.auditAppend ?? (async () => {});
  const nextEventId = deps.eventIdFactory ?? (() => randomUUID());

  const err = (reason: AssetCommandErrorReason, message: string) => ({
    ok: false as const,
    error: { reason, message },
  });

  const isUUID = (v: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

  const parseOptionalUUID = (
    raw: string | null | undefined,
    field: string,
  ): AssetCommandResult<string | null | undefined> => {
    if (raw === undefined || raw === null) return { ok: true, value: raw };
    if (raw.length === 0 || !isUUID(raw)) return err("invalid_request", `${field} must be a UUID when provided`);
    return { ok: true, value: raw };
  };

  const requireCapability = (actor: AssetActor) =>
    actor.capabilities.includes(ASSET_CAPABILITY)
      ? null
      : err("missing_capability", `${ASSET_CAPABILITY} capability required`);

  const auditEntry = (
    actor: AssetActor,
    action: string,
    targetType: Parameters<AssetAuditAppend>[0]["targetType"],
    targetId: string,
    metadata?: Record<string, unknown>,
  ): Parameters<AssetAuditAppend>[0] => ({
    actorId: actor.operatorId,
    action,
    targetType,
    targetId,
    // D2.4-2: the acting operator's org scopes the audit record.
    organizationId: actor.organizationId,
    ...(metadata === undefined ? {} : { metadata }),
    correlationId: actor.correlationId ?? null,
    causationId: null,
  });

  /**
   * D2.4-1 dispatch (reused from the membership/production/jobs/catalog/
   * generation services): run the mutation and its audit append inside ONE
   * database transaction when the repository supports it; otherwise fail
   * closed unless the test-only fallback flag is set.
   */
  const persistAndAudit = async <T>(
    actor: AssetActor,
    action: string,
    targetType: Parameters<AssetAuditAppend>[0]["targetType"],
    describe: (value: T) => { targetId: string; metadata?: Record<string, unknown> },
    run: (tx: AssetTransaction) => Promise<T>,
  ): Promise<T> => {
    if (repo.runInTransaction) {
      return repo.runInTransaction(async (tx) => {
        const value = await run(tx);
        const { targetId, metadata } = describe(value);
        await tx.appendAudit(auditEntry(actor, action, targetType, targetId, metadata));
        return value;
      });
    }
    if (deps.allowSequentialAudit !== true) {
      throw new Error(
        "D2.4-1 violation: repository does not implement runInTransaction; " +
          "asset mutations cannot commit without a same-transaction audit " +
          "record. (The sequential audit fallback is test-only and must be " +
          "enabled explicitly via allowSequentialAudit.)",
      );
    }
    const value = await run(directTx());
    const { targetId, metadata } = describe(value);
    await fallbackAudit(auditEntry(actor, action, targetType, targetId, metadata));
    return value;
  };

  const directTx = (): AssetTransaction => ({
    insertAsset: (input) => repo.insertAsset(input),
    updateAsset: (assetId, patch) => repo.updateAsset(assetId, patch),
    insertAssetVersion: (input) => repo.insertAssetVersion(input),
    insertLineageEdge: (input) => repo.insertLineageEdge(input),
    appendAudit: (entry) => fallbackAudit(entry),
  });

  const emit = async (
    name: "asset.created" | "asset.approved" | "asset.rejected",
    payload: Record<string, unknown>,
    correlation: { organizationId: string; productionId?: string | null },
  ) => {
    await emitEvent(publisher, {
      eventId: nextEventId(),
      name,
      correlation: {
        organizationId: correlation.organizationId,
        ...(correlation.productionId ? { productionId: correlation.productionId } : {}),
      },
      payload,
    });
  };

  /** Version-number rule: explicit per DM section 12; 0/absent = next free. */
  const nextVersionNumber = async (
    orgId: string,
    assetId: string,
    requested: number | undefined,
  ): Promise<AssetCommandResult<number>> => {
    if (requested !== undefined) {
      if (!Number.isInteger(requested) || requested <= 0) {
        return err("invalid_request", "versionNumber must be a positive integer when provided");
      }
      const existing = await repo.findVersionByNumber(orgId, assetId, requested);
      if (existing) {
        return err("invalid_request", `version ${requested} already exists for this asset`);
      }
      return { ok: true, value: requested };
    }
    const versions = await repo.listVersionsByAsset(orgId, assetId);
    const max = versions.reduce((m, v) => Math.max(m, v.versionNumber), 0);
    return { ok: true, value: max + 1 };
  };

  /**
   * D2.10-5 defense-in-depth cycle walk (the Stage 2.7 jobs precedent):
   * walk PARENT edges from the proposed parent version. The proposed child
   * is brand new (its id is not yet visible to edges), so a cycle is not
   * constructible through this API; the walk documents the invariant and
   * guards direct re-parenting misuse of the raw port. Depth is bounded.
   */
  const assertNoCycle = async (orgId: string, parentVersionId: string, childVersionId: string): Promise<AssetCommandErrorReason | null> => {
    const seen = new Set<string>([childVersionId]);
    let frontier = [parentVersionId];
    for (let depth = 0; frontier.length > 0 && depth < 64; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) return "cycle";
        seen.add(id);
        const parents = await repo.listParentEdges(orgId, id);
        next.push(...parents.map((e) => e.parentVersionId));
      }
      frontier = next;
    }
    return null;
  };

  return {
    async registerAsset(actor, input) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const orgId = actor.organizationId;

      if (!input.title || input.title.length > 512) {
        return err("invalid_request", "title must be a non-empty string of at most 512 characters");
      }
      if (!ASSET_KINDS.includes(input.kind)) {
        return err("invalid_request", "kind must be one of the approved asset kinds");
      }
      if (input.subtype != null && !ASSET_SUBTYPES.includes(input.subtype)) {
        return err("invalid_request", "subtype must be one of the approved asset subtypes");
      }
      if (input.description != null && input.description.length > 4096) {
        return err("invalid_request", "description must be at most 4096 characters when provided");
      }
      const productionParsed = await (async () => {
        const parsed = parseOptionalUUID(input.productionId, "productionId");
        return parsed;
      })();
      if (!productionParsed.ok) return productionParsed;
      const productionId = productionParsed.value;
      const shotParsed = parseOptionalUUID(input.shotId, "shotId");
      if (!shotParsed.ok) return shotParsed;
      const shotId = shotParsed.value;

      const asset = await persistAndAudit<AssetRecord>(
        actor,
        "assets.asset_created",
        "asset",
        (a) => ({ targetId: a.id, metadata: { kind: a.kind, ...(a.subtype ? { subtype: a.subtype } : {}) } }),
        (tx) =>
          tx.insertAsset({
            orgId,
            kind: input.kind,
            subtype: input.subtype ?? null,
            title: input.title,
            description: input.description ?? null,
            productionId: productionId ?? null,
            shotId: shotId ?? null,
            tags: [...(input.tags ?? [])],
          }),
      );
      await emit(
        "asset.created",
        { assetId: asset.id, kind: asset.kind, ...(asset.subtype ? { subtype: asset.subtype } : {}) },
        { organizationId: orgId, productionId: asset.productionId },
      );
      return { ok: true, value: asset };
    },

    async registerAssetVersion(actor, input) {
      // D2.10-4: operator-context-conditional audit + capability gating. An
      // actor WITH an operatorId is an operator (Control path): capability-
      // gated and audited. An actor WITHOUT one is the future execution-path
      // principal (trusted service-derived org, e.g. Generation output
      // registration): NO fake operator identity is invented and NO audit
      // row is written. Actors are always constructed server-side at
      // composition roots — a client can never craft either shape.
      const isOperator = actor != null && actor.operatorId.length > 0;
      if (isOperator && actor) {
        const capFail = requireCapability(actor);
        if (capFail) return capFail;
      }
      const orgId = actor?.organizationId;
      if (!orgId) {
        return err("invalid_request", "registerAssetVersion requires an actor organization in Stage 2.10");
      }

      if (!input.assetId || !isUUID(input.assetId)) {
        return err("invalid_request", "assetId must be a UUID");
      }
      const storage = input.storageRef;
      if (!storage) return err("invalid_request", "storageRef is required");
      if (typeof storage.bucket !== "string" || storage.bucket.length === 0 || storage.bucket.length > 255) {
        return err("invalid_request", "storageRef.bucket must be a non-empty string of at most 255 characters");
      }
      if (typeof storage.storageKey !== "string" || storage.storageKey.length === 0 || storage.storageKey.length > 1024) {
        return err("invalid_request", "storageRef.storageKey must be a non-empty string of at most 1024 characters");
      }
      if (typeof storage.checksum !== "string" || storage.checksum.length === 0 || storage.checksum.length > 256) {
        return err("invalid_request", "storageRef.checksum must be a non-empty string of at most 256 characters");
      }
      if (!Number.isInteger(storage.byteSize) || storage.byteSize <= 0) {
        return err("invalid_request", "storageRef.byteSize must be a positive integer");
      }
      if (typeof storage.mimeType !== "string" || storage.mimeType.length === 0 || storage.mimeType.length > 255) {
        return err("invalid_request", "storageRef.mimeType must be a non-empty string of at most 255 characters");
      }

      // The parent asset must exist in the SAME organization; cross-org
      // targets are indistinguishable from absent ones (IDOR-safe).
      const asset = await repo.findAssetById(input.assetId);
      if (!asset || asset.orgId !== orgId) {
        return err("asset_not_found", "asset does not exist in your organization");
      }

      // Provenance is a metadata reference only; it must be same-org when
      // provided (fail closed on cross-org generation references).
      let provenanceGenerationId: string | null = null;
      if (input.provenanceGenerationId != null) {
        const parsed = parseOptionalUUID(input.provenanceGenerationId, "provenanceGenerationId");
        if (!parsed.ok) return parsed;
        if (parsed.value != null && !isUUID(parsed.value)) {
          return err("invalid_request", "provenanceGenerationId must be a UUID when provided");
        }
        // Stage 2.10: no Generation read port exists (no Generation ->
        // Assets wiring and no Asset -> Generation invocation). The service
        // enforces org consistency at the SERVICE level only when a
        // generation-lookup port is configured; otherwise the reference is
        // stored as opaque provenance metadata (never an authorization
        // boundary). D2.10-4 audit still applies to the version row.
        provenanceGenerationId = parsed.value ?? null;
      }

      const versionNumberResult = await nextVersionNumber(orgId, asset.id, input.versionNumber);
      if (!versionNumberResult.ok) return versionNumberResult;
      const versionNumberFinal = versionNumberResult.value;

      // Lineage parent (single edge per registration): it must exist in the
      // SAME organization (cross-org parents fail closed, IDOR-safe) and
      // must not create a cycle.
      let lineageEdge: AssetLineageRecord | null = null;
      if (input.derivedFrom) {
        if (!isUUID(input.derivedFrom.parentVersionId)) {
          return err("invalid_request", "derivedFrom.parentVersionId must be a UUID");
        }
        if (!ASSET_DERIVATION_KINDS.includes(input.derivedFrom.derivationKind)) {
          return err("invalid_request", "derivationKind must be one of the approved derivation kinds");
        }
        const parent = await repo.findVersionById(input.derivedFrom.parentVersionId);
        if (!parent || parent.orgId !== orgId) {
          return err("parent_not_found", "parent version does not exist in your organization");
        }
        const cycleReason = await assertNoCycle(orgId, parent.id, "pending-new-version");
        if (cycleReason) return err(cycleReason, "lineage edge would create a cycle");
      }

      const outcome = await (async (): Promise<AssetCommandResult<RegisterVersionOutcome>> => {
        const run = async (tx: AssetTransaction): Promise<RegisterVersionOutcome> => {
          const version = await tx.insertAssetVersion({
            orgId,
            assetId: asset.id,
            versionNumber: versionNumberFinal,
            bucket: storage.bucket,
            storageKey: storage.storageKey,
            checksum: storage.checksum,
            byteSize: storage.byteSize,
            mimeType: storage.mimeType,
            technicalMetadata: input.technicalMetadata ?? {},
            provenanceGenerationId,
            createdBy: actor?.operatorId ?? null,
          });
          let edge: AssetLineageRecord | null = null;
          if (input.derivedFrom) {
            edge = await tx.insertLineageEdge({
              orgId,
              parentVersionId: input.derivedFrom.parentVersionId,
              childVersionId: version.id,
              derivationKind: input.derivedFrom.derivationKind,
            });
          }
          // D2.10-1 + DM section 32.4: a superseding version restarts the
          // approval cycle. The current-version pointer moves to the new
          // version; approval resets to `pending` (the pointer is the ONLY
          // mutable version reference — the versions themselves are never
          // rewritten).
          const updated = await tx.updateAsset(asset.id, {
            currentVersionId: version.id,
            approvalState: "pending",
          });
          // D2.10-4: audit ONLY when an operator context exists.
          if (isOperator && actor) {
            await tx.appendAudit(
              auditEntry(
                actor,
                "assets.asset_version_registered",
                "asset_version",
                version.id,
                {
                  assetId: asset.id,
                  versionNumber: version.versionNumber,
                  ...(edge ? { lineageId: edge.id, derivationKind: edge.derivationKind } : {}),
                  ...(provenanceGenerationId ? { provenanceGenerationId } : {}),
                },
              ),
            );
          }
          return { version, asset: updated, lineage: edge };
        };
        if (repo.runInTransaction) {
          const committed = await repo.runInTransaction(run);
          return { ok: true as const, value: committed };
        }
        // registerAssetVersion mutates THREE families atomically (version +
        // optional edge + aggregate pointer/state), so it REQUIRES a
        // transactional repository — fail closed without one.
        throw new Error(
          "D2.4-1 violation: registerAssetVersion requires a transactional repository so the " +
            "version INSERT, lineage edge, and aggregate pointer commit atomically",
        );
      })();
      if (!outcome.ok) return outcome;

      const value = outcome.value;
      await emit(
        "asset.created",
        {
          assetId: value.asset.id,
          assetVersionId: value.version.id,
          versionNumber: value.version.versionNumber,
          ...(value.lineage ? { lineageId: value.lineage.id, derivationKind: value.lineage.derivationKind } : {}),
        },
        { organizationId: orgId, productionId: value.asset.productionId },
      );
      return { ok: true, value };
    },

    async submitForReview(actor, assetId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const asset = await repo.findAssetById(assetId);
      if (!asset || asset.orgId !== actor.organizationId) {
        return err("asset_not_found", "asset does not exist in your organization");
      }
      if (!ASSET_APPROVAL_TRANSITIONS[asset.approvalState].includes("in_review")) {
        return err("invalid_transition", `cannot submit a ${asset.approvalState} asset for review`);
      }
      const updated = await persistAndAudit<AssetRecord>(
        actor,
        "assets.asset_submitted_for_review",
        "asset",
        (a) => ({ targetId: a.id, metadata: { from: asset.approvalState, to: a.approvalState } }),
        (tx) => tx.updateAsset(asset.id, { approvalState: "in_review" }),
      );
      return { ok: true, value: updated };
    },

    async approveAssetVersion(actor, assetId) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      const asset = await repo.findAssetById(assetId);
      if (!asset || asset.orgId !== actor.organizationId) {
        return err("asset_not_found", "asset does not exist in your organization");
      }
      if (!ASSET_APPROVAL_TRANSITIONS[asset.approvalState].includes("approved")) {
        return err("invalid_transition", `cannot approve a ${asset.approvalState} asset`);
      }
      const updated = await persistAndAudit<AssetRecord>(
        actor,
        "assets.asset_approved",
        "asset",
        (a) => ({ targetId: a.id, metadata: { from: asset.approvalState, to: a.approvalState } }),
        (tx) => tx.updateAsset(asset.id, { approvalState: "approved" }),
      );
      await emit(
        "asset.approved",
        { assetId: updated.id, currentVersionId: updated.currentVersionId },
        { organizationId: actor.organizationId, productionId: updated.productionId },
      );
      return { ok: true, value: updated };
    },

    async rejectAssetVersion(actor, assetId, reason) {
      const capFail = requireCapability(actor);
      if (capFail) return capFail;
      if (!reason || reason.length > 2048) {
        return err("invalid_request", "reason must be a non-empty string of at most 2048 characters");
      }
      const asset = await repo.findAssetById(assetId);
      if (!asset || asset.orgId !== actor.organizationId) {
        return err("asset_not_found", "asset does not exist in your organization");
      }
      if (!ASSET_APPROVAL_TRANSITIONS[asset.approvalState].includes("rejected")) {
        return err("invalid_transition", `cannot reject a ${asset.approvalState} asset`);
      }
      const updated = await persistAndAudit<AssetRecord>(
        actor,
        "assets.asset_rejected",
        "asset",
        (a) => ({ targetId: a.id, metadata: { from: asset.approvalState, to: a.approvalState } }),
        (tx) => tx.updateAsset(asset.id, { approvalState: "rejected" }),
      );
      await emit(
        "asset.rejected",
        { assetId: updated.id, currentVersionId: updated.currentVersionId, reason },
        { organizationId: actor.organizationId, productionId: updated.productionId },
      );
      return { ok: true, value: updated };
    },

    async getAsset(actor, assetId) {
      const asset = await repo.findAssetById(assetId);
      if (!asset || asset.orgId !== actor.organizationId) {
        return err("asset_not_found", "asset does not exist in your organization");
      }
      return { ok: true, value: asset };
    },

    async getAssetVersion(actor, versionId) {
      const version = await repo.findVersionById(versionId);
      if (!version || version.orgId !== actor.organizationId) {
        return err("version_not_found", "asset version does not exist in your organization");
      }
      return { ok: true, value: version };
    },

    async listAssetVersions(actor, assetId) {
      const asset = await repo.findAssetById(assetId);
      if (!asset || asset.orgId !== actor.organizationId) {
        return err("asset_not_found", "asset does not exist in your organization");
      }
      return { ok: true, value: await repo.listVersionsByAsset(actor.organizationId, assetId) };
    },

    async getLineageParents(actor, versionId) {
      const version = await repo.findVersionById(versionId);
      if (!version || version.orgId !== actor.organizationId) {
        return err("version_not_found", "asset version does not exist in your organization");
      }
      // D2.10-5: single hop only.
      return { ok: true, value: await repo.listParentEdges(actor.organizationId, version.id) };
    },

    async getLineageChildren(actor, versionId) {
      const version = await repo.findVersionById(versionId);
      if (!version || version.orgId !== actor.organizationId) {
        return err("version_not_found", "asset version does not exist in your organization");
      }
      // D2.10-5: single hop only.
      return { ok: true, value: await repo.listChildEdges(actor.organizationId, version.id) };
    },

    async listAssets(actor, filter) {
      return repo.listAssetsByOrg(actor.organizationId, filter);
    },
  };
};
