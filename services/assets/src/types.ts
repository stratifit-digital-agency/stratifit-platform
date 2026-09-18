/**
 * Asset-domain service ports (Stage 2.10, approved plan; D2.10-1..D2.10-5).
 *
 * services/assets owns the Asset bounded context (SVC section 11 context 6):
 * assets, asset_versions, asset_lineage. No database imports here — this
 * module declares the injectable ports; the Drizzle adapter implements them.
 * Cross-module subjects (production, shot, generation provenance) stay LOOSE
 * references (approved D2): there is NO Generation -> Assets wiring and NO
 * Asset -> Generation invocation — provenance is a metadata UUID only.
 *
 * D2.10-1: approval state (DM section 32.4) lives on the MUTABLE assets
 * aggregate; asset_versions are immutable (DM section 12, invariant 24) and
 * asset_lineage edges are immutable (invariant 25).
 *
 * D2.10-5: lineage reads are single-hop only — the repository exposes edge
 * lookups by parent/child version, never traversal.
 */
import type { ControlCapability } from "@stratifit/permissions";

/** Operator authorization role (mirrors @stratifit/auth OperatorRole). */
export type OperatorRole = "admin" | "operator" | "reviewer" | "viewer";

/** DM section 12: the approved asset-kind taxonomy (no invented kinds). */
export type AssetKind = "video" | "audio" | "image" | "document" | "subtitle" | "data";

/** Runtime allowlist mirror (schema-level CHECK has the same values). */
export const ASSET_KINDS: readonly AssetKind[] = ["video", "audio", "image", "document", "subtitle", "data"];

/** DM section 12: asset subtypes (exact architecture terminology). */
export type AssetSubtype =
  | "master"
  | "derivative"
  | "thumbnail"
  | "poster"
  | "trailer"
  | "clip"
  | "sample"
  | "subtitle"
  | "lyrics"
  | "caption"
  | "document";

/** Runtime allowlist mirror (schema-level CHECK has the same values). */
export const ASSET_SUBTYPES: readonly AssetSubtype[] = [
  "master",
  "derivative",
  "thumbnail",
  "poster",
  "trailer",
  "clip",
  "sample",
  "subtitle",
  "lyrics",
  "caption",
  "document",
];

/** D2.10-1: the DM section 32.4 approval state machine on the aggregate. */
export type AssetApprovalState = "pending" | "in_review" | "approved" | "rejected";

/** DM section 12: visibility — public is granted at PUBLICATION, never here. */
export type AssetVisibility = "internal" | "public";

/** DM section 12: lineage derivation kinds (relationship metadata only). */
export type AssetDerivationKind =
  | "generation"
  | "edit"
  | "transcode"
  | "thumbnail"
  | "trailer"
  | "upscale"
  | "enhancement";

/** Runtime allowlist mirror (schema-level CHECK has the same values). */
export const ASSET_DERIVATION_KINDS: readonly AssetDerivationKind[] = [
  "generation",
  "edit",
  "transcode",
  "thumbnail",
  "trailer",
  "upscale",
  "enhancement",
];

/**
 * The approved approval state machine (DM section 32.4) — legal edges ONLY.
 * `approved` is terminal FOR THE CURRENT VERSION (D2.10-1): a superseding
 * version resets the aggregate to `pending` at registration time, restarting
 * the cycle; `rejected -> pending` is the documented recovery edge. No
 * invented transitions.
 */
export const ASSET_APPROVAL_TRANSITIONS: Readonly<
  Record<AssetApprovalState, readonly AssetApprovalState[]>
> = {
  pending: ["in_review"],
  in_review: ["approved", "rejected"],
  approved: [],
  rejected: ["pending"],
};

/** Server-derived authorization facts an asset command actor must present. */
export interface AssetActor {
  /** The acting operator's row id (identity.userId at composition roots). */
  readonly operatorId: string;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
  /** Optional correlation id propagated into audit records. */
  readonly correlationId?: string | null;
}

/** StorageRef metadata (DATA_FLOW section 11) — references, never binaries. */
export interface StorageRefInput {
  readonly bucket: string;
  readonly storageKey: string;
  readonly checksum: string;
  readonly byteSize: number;
  readonly mimeType: string;
}

export interface AssetRecord {
  readonly id: string;
  readonly orgId: string;
  readonly kind: AssetKind;
  readonly subtype: AssetSubtype | null;
  readonly title: string;
  readonly description: string | null;
  /** Invariant 24: the only mutable version reference. Null until v1. */
  readonly currentVersionId: string | null;
  /** D2.10-1: the DM section 32.4 state machine lives here. */
  readonly approvalState: AssetApprovalState;
  readonly visibility: AssetVisibility;
  /** Loose cross-module refs (approved D2) — no FKs to other families. */
  readonly productionId: string | null;
  readonly shotId: string | null;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AssetVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly assetId: string;
  readonly versionNumber: number;
  /** StorageRef metadata (DATA_FLOW section 11). */
  readonly bucket: string;
  readonly storageKey: string;
  readonly checksum: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly technicalMetadata: Record<string, unknown>;
  /** Provenance metadata reference into the Stage 2.9 generation family. */
  readonly provenanceGenerationId: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface AssetLineageRecord {
  readonly id: string;
  readonly orgId: string;
  readonly parentVersionId: string;
  readonly childVersionId: string;
  readonly derivationKind: AssetDerivationKind;
  readonly createdAt: string;
}

export type AssetCommandErrorReason =
  | "missing_capability"
  | "cross_org"
  | "asset_not_found"
  | "version_not_found"
  | "parent_not_found"
  | "parent_cross_org"
  | "provenance_not_found"
  | "provenance_cross_org"
  | "production_not_found"
  | "invalid_request"
  | "invalid_transition"
  | "self_edge"
  | "cycle"
  | "duplicate_edge";

export type AssetCommandError = {
  readonly reason: AssetCommandErrorReason;
  readonly message: string;
};

export type AssetCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AssetCommandError };

/**
 * Audit entry accepted by the sanctioned admin-audit seam (D2.4-1 reused;
 * same shape as the identity/jobs/catalog/generation seams; composition
 * roots map it to admin-audit's canonical entry).
 */
export type AssetAuditAppend = (entry: {
  actorId: string;
  action: string;
  targetType: "asset" | "asset_version" | "asset_lineage";
  targetId: string;
  /** Org scope for organization-scoped audit reads (D2.4-2). */
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}) => Promise<void>;

export interface RegisterAssetInput {
  readonly kind: AssetKind;
  readonly subtype?: AssetSubtype | null;
  readonly title: string;
  readonly description?: string | null;
  /** Loose cross-module refs (approved D2) — service-validated same-org. */
  readonly productionId?: string | null;
  readonly shotId?: string | null;
  readonly tags?: readonly string[];
}

export interface RegisterAssetVersionInput {
  readonly assetId: string;
  /** Explicit version number per DM section 12; 0 = next free number. */
  readonly versionNumber?: number;
  /** StorageRef metadata (DATA_FLOW section 11) — required on every version. */
  readonly storageRef: StorageRefInput;
  readonly technicalMetadata?: Record<string, unknown>;
  /** Provenance metadata reference into the Stage 2.9 generation family. */
  readonly provenanceGenerationId?: string | null;
  /** Single-hop lineage edges from a PARENT version to this new version. */
  readonly derivedFrom?: {
    readonly parentVersionId: string;
    readonly derivationKind: AssetDerivationKind;
  } | null;
}

/** Transaction-scoped persistence + audit append (D2.4-1, reused). */
export interface AssetTransaction {
  insertAsset(input: {
    orgId: string;
    kind: AssetKind;
    subtype: AssetSubtype | null;
    title: string;
    description: string | null;
    productionId: string | null;
    shotId: string | null;
    tags: readonly string[];
  }): Promise<AssetRecord>;
  updateAsset(
    assetId: string,
    patch: {
      approvalState?: AssetApprovalState;
      currentVersionId?: string | null;
      title?: string;
      description?: string | null;
      visibility?: AssetVisibility;
      tags?: readonly string[];
    },
  ): Promise<AssetRecord>;
  insertAssetVersion(input: {
    orgId: string;
    assetId: string;
    versionNumber: number;
    bucket: string;
    storageKey: string;
    checksum: string;
    byteSize: number;
    mimeType: string;
    technicalMetadata: Record<string, unknown>;
    provenanceGenerationId: string | null;
    createdBy: string | null;
  }): Promise<AssetVersionRecord>;
  insertLineageEdge(input: {
    orgId: string;
    parentVersionId: string;
    childVersionId: string;
    derivationKind: AssetDerivationKind;
  }): Promise<AssetLineageRecord>;
  appendAudit(entry: Parameters<AssetAuditAppend>[0]): Promise<void>;
}

export interface AssetRepository {
  findAssetById(id: string): Promise<AssetRecord | null>;
  findVersionById(id: string): Promise<AssetVersionRecord | null>;
  findVersionByNumber(orgId: string, assetId: string, versionNumber: number): Promise<AssetVersionRecord | null>;
  listVersionsByAsset(orgId: string, assetId: string): Promise<AssetVersionRecord[]>;
  findLineageEdge(orgId: string, parentVersionId: string, childVersionId: string): Promise<AssetLineageRecord | null>;
  /** D2.10-5: single-hop only — direct parents of one version. */
  listParentEdges(orgId: string, childVersionId: string): Promise<AssetLineageRecord[]>;
  /** D2.10-5: single-hop only — direct children of one version. */
  listChildEdges(orgId: string, parentVersionId: string): Promise<AssetLineageRecord[]>;
  listAssetsByOrg(orgId: string, filter?: { kind?: AssetKind; approvalState?: AssetApprovalState }): Promise<AssetRecord[]>;
  insertAsset(input: Parameters<AssetTransaction["insertAsset"]>[0]): Promise<AssetRecord>;
  updateAsset(assetId: string, patch: Parameters<AssetTransaction["updateAsset"]>[1]): Promise<AssetRecord>;
  insertAssetVersion(input: Parameters<AssetTransaction["insertAssetVersion"]>[0]): Promise<AssetVersionRecord>;
  insertLineageEdge(input: Parameters<AssetTransaction["insertLineageEdge"]>[0]): Promise<AssetLineageRecord>;
  runInTransaction?<T>(work: (tx: AssetTransaction) => Promise<T>): Promise<T>;
}
