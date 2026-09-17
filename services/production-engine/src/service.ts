/**
 * Production domain service (Stage 2.6, decisions D2.6-1..D2.6-4).
 *
 * Commands enforce, in order: capability (`production.plan` /
 * `production.approve`) -> org boundary -> state-machine validity ->
 * invariant checks -> persistence -> post-commit event publication
 * (Stage-1 semantics, existing production.* names only).
 *
 * D2.4-1 (reused): security-critical mutations (gate decision, approve,
 * request changes, manifest issuance) and their audit records commit inside
 * the SAME database transaction via `ProductionRepository.runInTransaction` —
 * a crash before COMMIT rolls back BOTH, and a successful mutation cannot
 * commit without its audit record. Repositories without transaction support
 * fail closed unless the TEST-ONLY `allowSequentialAudit` flag is set;
 * production composition roots never set it. The approved production state
 * machine (DM section 32.1) is the only legal path between states, and
 * approval requires a recorded passing gate decision for the current plan
 * version (invariant 1).
 */
import { randomUUID } from "node:crypto";
import type { ProductionManifest } from "@stratifit/contracts";
import type { ControlCapability } from "@stratifit/permissions";
import { emitEvent, InProcessEventPublisher, type EventPublisher } from "@stratifit/events";
import { buildManifest } from "./manifest-builder";
import type {
  GateDecisionRecord,
  ManifestVersionRecord,
  PlanVersionRecord,
  ProductionActor,
  ProductionAuditAppend,
  ProductionCommandErrorReason,
  ProductionCommandResult,
  ProductionGate,
  ProductionKind,
  ProductionRepository,
  ProductionStatus,
  ProductionTransaction,
  ProjectRecord,
} from "./types";
import { PRODUCTION_TRANSITIONS } from "./types";

export interface ProductionServiceDeps {
  repository: ProductionRepository;
  /** Defaults to an in-process publisher with no handlers (Stage-1 semantics). */
  publisher?: EventPublisher;
  /** Fallback audit seam (used only when the repository has no transaction support). */
  auditAppend?: ProductionAuditAppend;
  /**
   * TEST-ONLY: permit the sequential (non-transactional) audit fallback for
   * repositories without `runInTransaction`. Production composition roots
   * never set it — there the service fail-closes instead (D2.4-1).
   */
  allowSequentialAudit?: boolean;
  eventIdFactory?: () => string;
}

export interface ProductionService {
  listProjects(actor: ProductionActor): Promise<ProjectRecord[]>;
  createProject(
    actor: ProductionActor,
    input: { slug: string; name: string; description?: string },
  ): Promise<ProductionCommandResult<ProjectRecord>>;
  listProductions(actor: ProductionActor): Promise<{ id: string; orgId: string; projectId: string; title: string; kind: ProductionKind; status: ProductionStatus; currentPlanVersionId: string | null; currentManifestVersionId: string | null }[]>;
  createProduction(
    actor: ProductionActor,
    input: { projectId: string; title: string; kind: ProductionKind },
  ): Promise<ProductionCommandResult<{ id: string; orgId: string; projectId: string; title: string; kind: ProductionKind; status: ProductionStatus; currentPlanVersionId: string | null; currentManifestVersionId: string | null }>>;
  getProduction(actor: ProductionActor, productionId: string): Promise<ProductionCommandResult<{ id: string; orgId: string; projectId: string; title: string; kind: ProductionKind; status: ProductionStatus; currentPlanVersionId: string | null; currentManifestVersionId: string | null }>>;
  recordPlanVersion(
    actor: ProductionActor,
    input: { productionId: string; planDocument: Record<string, unknown> },
  ): Promise<ProductionCommandResult<PlanVersionRecord>>;
  submitToGate(
    actor: ProductionActor,
    input: { productionId: string; budgetUsd?: number; moderationPlanned?: boolean },
  ): Promise<ProductionCommandResult<GateDecisionRecord>>;
  recordGateDecision(
    actor: ProductionActor,
    input: { productionId: string; decision: "approve" | "changes_requested" },
  ): Promise<ProductionCommandResult<{ production: { id: string; orgId: string; projectId: string; title: string; kind: ProductionKind; status: ProductionStatus; currentPlanVersionId: string | null; currentManifestVersionId: string | null } }>>;
  issueManifest(
    actor: ProductionActor,
    input: { productionId: string },
  ): Promise<ProductionCommandResult<ManifestVersionRecord>>;
}

const PLAN_CAPABILITY: ControlCapability = "production.plan";
const APPROVE_CAPABILITY: ControlCapability = "production.approve";

type ProductionSummary = {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  kind: ProductionKind;
  status: ProductionStatus;
  currentPlanVersionId: string | null;
  currentManifestVersionId: string | null;
};

const summarize = (p: {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  kind: ProductionKind;
  status: ProductionStatus;
  currentPlanVersionId: string | null;
  currentManifestVersionId: string | null;
}): ProductionSummary => ({
  id: p.id,
  orgId: p.orgId,
  projectId: p.projectId,
  title: p.title,
  kind: p.kind,
  status: p.status,
  currentPlanVersionId: p.currentPlanVersionId,
  currentManifestVersionId: p.currentManifestVersionId,
});

export const createProductionService = (deps: ProductionServiceDeps): ProductionService => {
  const repo = deps.repository;
  const publisher = deps.publisher ?? new InProcessEventPublisher();
  const fallbackAudit = deps.auditAppend ?? (async () => {});
  const nextEventId = deps.eventIdFactory ?? (() => randomUUID());

  const err = (reason: ProductionCommandErrorReason, message: string) => ({
    ok: false as const,
    error: { reason, message },
  });

  const requireCapability = (actor: ProductionActor, capability: ControlCapability) =>
    actor.capabilities.includes(capability) ? null : err("missing_capability", `${capability} capability required`);

  const auditEntry = (
    actor: ProductionActor,
    action: string,
    targetType: Parameters<ProductionAuditAppend>[0]["targetType"],
    targetId: string,
    metadata?: Record<string, unknown>,
  ): Parameters<ProductionAuditAppend>[0] => ({
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
   * D2.4-1 dispatch (reused from the membership service): run the mutation
   * and its audit append inside ONE database transaction when the repository
   * supports it; otherwise fail closed unless the test-only fallback flag is
   * set. The audit record describes the persisted value.
   */
  const persistAndAudit = async <T>(
    actor: ProductionActor,
    action: string,
    targetType: Parameters<ProductionAuditAppend>[0]["targetType"],
    describe: (value: T) => { targetId: string; metadata?: Record<string, unknown> },
    run: (tx: ProductionTransaction) => Promise<T>,
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
          "production mutations cannot commit without a same-transaction audit " +
          "record. (The sequential audit fallback is test-only and must be " +
          "enabled explicitly via allowSequentialAudit.)",
      );
    }
    const fallbackTx: ProductionTransaction = {
      insertProject: (input) => repo.insertProject(input),
      insertProduction: (input) => repo.insertProduction(input),
      insertPlanVersion: (input) => repo.insertPlanVersion(input),
      updateProduction: (id, patch) => repo.updateProduction(id, patch),
      insertGateDecision: (input) => repo.insertGateDecision(input),
      insertManifestVersion: (input) => repo.insertManifestVersion(input),
      appendAudit: (entry) => fallbackAudit(entry),
    };
    const value = await run(fallbackTx);
    const { targetId, metadata } = describe(value);
    await fallbackAudit(auditEntry(actor, action, targetType, targetId, metadata));
    return value;
  };

  const emit = async (
    name: "production.created" | "production.updated" | "production.approved",
    payload: Record<string, unknown>,
    correlation: { organizationId?: string; projectId?: string; productionId?: string },
  ) => {
    await emitEvent(publisher, {
      eventId: nextEventId(),
      name,
      correlation,
      payload,
    });
  };

  return {
    async listProjects(actor) {
      return repo.listProjectsByOrg(actor.organizationId);
    },

    async createProject(actor, input) {
      const capFail = requireCapability(actor, PLAN_CAPABILITY);
      if (capFail) return capFail;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
        return err("invalid_request", "project slug must be lowercase kebab-case");
      }
      const existing = await repo.findProjectBySlug(actor.organizationId, input.slug);
      if (existing) return err("duplicate_slug", `project slug '${input.slug}' already exists in this organization`);

      const project = await persistAndAudit<ProjectRecord>(
        actor,
        "production.project_created",
        "project",
        (p) => ({ targetId: p.id, metadata: { slug: p.slug } }),
        (tx) =>
          tx.insertProject({
            orgId: actor.organizationId,
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            createdBy: actor.operatorId,
          }),
      );
      await emit(
        "production.created",
        { entityType: "project", projectId: project.id, slug: project.slug },
        { organizationId: actor.organizationId, projectId: project.id },
      );
      return { ok: true, value: project };
    },

    async listProductions(actor) {
      const rows = await repo.listProductionsByOrg(actor.organizationId);
      return rows.map(summarize);
    },

    async createProduction(actor, input) {
      const capFail = requireCapability(actor, PLAN_CAPABILITY);
      if (capFail) return capFail;
      const project = await repo.findProjectById(input.projectId);
      if (!project || project.orgId !== actor.organizationId) {
        return err("project_not_found", "project does not exist in your organization");
      }
      if (project.status !== "active") return err("invalid_request", "project is not active");

      const production = await persistAndAudit<ProductionRecordShape>(
        actor,
        "production.created",
        "production",
        (p) => ({ targetId: p.id, metadata: { projectId: p.projectId, kind: p.kind } }),
        (tx) =>
          tx.insertProduction({
            orgId: actor.organizationId,
            projectId: input.projectId,
            title: input.title,
            kind: input.kind,
          }),
      );
      await emit(
        "production.created",
        { entityType: "production", productionId: production.id, projectId: production.projectId, kind: production.kind },
        { organizationId: actor.organizationId, projectId: production.projectId, productionId: production.id },
      );
      return { ok: true, value: summarize(production) };
    },

    async getProduction(actor, productionId) {
      const production = await repo.findProductionById(productionId);
      if (!production || production.orgId !== actor.organizationId) {
        return err("production_not_found", "production does not exist in your organization");
      }
      return { ok: true, value: summarize(production) };
    },

    async recordPlanVersion(actor, input) {
      const capFail = requireCapability(actor, PLAN_CAPABILITY);
      if (capFail) return capFail;
      const production = await repo.findProductionById(input.productionId);
      if (!production || production.orgId !== actor.organizationId) {
        return err("production_not_found", "production does not exist in your organization");
      }
      // Any state other than a terminal one may receive a new plan version;
      // material changes always create a new IMMUTABLE version (DM section 7).
      if (production.status === "archived" || production.status === "cancelled" || production.status === "published") {
        return err("invalid_transition", `cannot record a plan version on a ${production.status} production`);
      }
      const latest = await repo.findLatestPlanVersion(production.id);
      const nextVersion = (latest?.versionNumber ?? 0) + 1;

      const version = await persistAndAudit<PlanVersionRecord>(
        actor,
        "production.plan_version_recorded",
        "plan_version",
        (v) => ({ targetId: v.id, metadata: { productionId: v.productionId, versionNumber: v.versionNumber } }),
        async (tx) => {
          const created = await tx.insertPlanVersion({
            orgId: actor.organizationId,
            productionId: production.id,
            versionNumber: nextVersion,
            planDocument: input.planDocument,
            createdBy: actor.operatorId,
          });
          // Current pointer moves to the new version (DM section 33); the
          // version rows themselves are immutable.
          await tx.updateProduction(production.id, {
            currentPlanVersionId: created.id,
            ...(production.status === "draft" ? { status: "planning" satisfies ProductionStatus } : {}),
          });
          return created;
        },
      );

      await emit(
        "production.updated",
        { entityType: "plan_version", productionId: production.id, planVersionId: version.id, versionNumber: version.versionNumber },
        { organizationId: actor.organizationId, projectId: production.projectId, productionId: production.id },
      );
      return { ok: true, value: version };
    },

    async submitToGate(actor, input) {
      const capFail = requireCapability(actor, PLAN_CAPABILITY);
      if (capFail) return capFail;
      const production = await repo.findProductionById(input.productionId);
      if (!production || production.orgId !== actor.organizationId) {
        return err("production_not_found", "production does not exist in your organization");
      }
      if (production.status !== "planning" && production.status !== "in_gate") {
        return err("invalid_transition", `production must be planning or in_gate to submit to the gate (state: ${production.status})`);
      }
      const planVersionId = production.currentPlanVersionId;
      if (!planVersionId) return err("invalid_request", "production has no current plan version");
      const planVersion = await repo.findPlanVersionById(planVersionId);
      if (!planVersion) return err("plan_version_not_found", "current plan version not found");

      // Build the manifest DRAFT from the plan document and evaluate the
      // existing pure gate (no AI, no compute — deterministic rule evaluation).
      const plan = planVersion.planDocument as {
        sceneCount: number;
        shotCount: number;
        modelSelections: ProductionManifest["modelSelections"];
        workflowSelections: ProductionManifest["workflowSelections"];
        computeEstimate: ProductionManifest["computeEstimate"];
        rights: ProductionManifest["rights"];
        safety: { moderationRequired: boolean };
      };
      const draft = buildManifest({
        organizationId: production.orgId,
        productionId: production.id,
        approvedBy: actor.operatorId,
        sceneCount: plan.sceneCount,
        shotCount: plan.shotCount,
        modelSelections: plan.modelSelections,
        workflowSelections: plan.workflowSelections,
        computeEstimate: plan.computeEstimate,
        rights: plan.rights,
        safety: plan.safety,
        plan: planVersion.planDocument,
      });
      const gate: ProductionGate = evaluateGate;
      const decision = gate({
        manifest: draft,
        budgetUsd: input.budgetUsd,
        moderationPlanned: input.moderationPlanned,
      });
      const inputsSnapshot: Record<string, unknown> = {
        ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
        ...(input.moderationPlanned !== undefined ? { moderationPlanned: input.moderationPlanned } : {}),
      };

      // In-gate state + immutable gate record, one transaction (D2.4-1).
      const result = await persistAndAudit<GateDecisionRecord>(
        actor,
        "production.gate_evaluated",
        "gate_decision",
        (g) => ({ targetId: g.id, metadata: { productionId: g.productionId, planVersionId: g.planVersionId, decision: g.decision } }),
        async (tx) => {
          const record = await tx.insertGateDecision({
            orgId: actor.organizationId,
            productionId: production.id,
            planVersionId: planVersion.id,
            decision: decision.passed ? "pass" : "fail",
            inputsSnapshot,
            issues: decision.issues,
            evaluatedBy: actor.operatorId,
          });
          if (production.status === "planning") {
            await tx.updateProduction(production.id, { status: "in_gate" satisfies ProductionStatus });
          }
          return record;
        },
      );

      await emit(
        "production.updated",
        { entityType: "gate_decision", productionId: production.id, gateDecisionId: result.id, decision: result.decision },
        { organizationId: actor.organizationId, projectId: production.projectId, productionId: production.id },
      );
      if (!decision.passed) {
        return err("gate_failed", `gate evaluation failed: ${decision.issues.map((i) => i.code).join(", ")}`);
      }
      return { ok: true, value: result };
    },

    async recordGateDecision(actor, input) {
      const capFail = requireCapability(actor, APPROVE_CAPABILITY);
      if (capFail) return capFail;
      const production = await repo.findProductionById(input.productionId);
      if (!production || production.orgId !== actor.organizationId) {
        return err("production_not_found", "production does not exist in your organization");
      }
      if (production.status !== "in_gate") {
        return err("invalid_transition", `production must be in_gate to record a gate decision (state: ${production.status})`);
      }
      const planVersionId = production.currentPlanVersionId;
      if (!planVersionId) return err("invalid_request", "production has no current plan version");

      // Invariant 1: approval requires a recorded PASSING gate decision for
      // the production's CURRENT plan version. Fail closed without one.
      const passing = await repo.findPassingGateDecision(production.id, planVersionId);
      if (input.decision === "approve" && !passing) {
        return err("gate_not_passed", "approval requires a recorded passing gate decision for the current plan version");
      }

      const nextStatus: ProductionStatus =
        input.decision === "approve" ? "approved" : "changes_requested";

      const updated = await persistAndAudit<{ production: ProductionRecordShape }>(
        actor,
        input.decision === "approve" ? "production.approved" : "production.changes_requested",
        "production",
        (r) => ({ targetId: r.production.id, metadata: { from: production.status, to: r.production.status, decision: input.decision } }),
        (tx) =>
          (async () => {
            const moved = await tx.updateProduction(production.id, { status: nextStatus });
            return { production: moved };
          })(),
      );

      await emit(
        input.decision === "approve" ? "production.approved" : "production.updated",
        { entityType: "production", productionId: production.id, previousStatus: production.status, status: nextStatus },
        { organizationId: actor.organizationId, projectId: production.projectId, productionId: production.id },
      );
      return { ok: true, value: { production: summarize(updated.production) } };
    },

    async issueManifest(actor, input) {
      const capFail = requireCapability(actor, APPROVE_CAPABILITY);
      if (capFail) return capFail;
      const production = await repo.findProductionById(input.productionId);
      if (!production || production.orgId !== actor.organizationId) {
        return err("production_not_found", "production does not exist in your organization");
      }
      if (production.status !== "approved") {
        return err("invalid_transition", `manifest can only be issued for an approved production (state: ${production.status})`);
      }
      const planVersionId = production.currentPlanVersionId;
      if (!planVersionId) return err("invalid_request", "production has no current plan version");
      const planVersion = await repo.findPlanVersionById(planVersionId);
      if (!planVersion) return err("plan_version_not_found", "current plan version not found");
      // Invariant 1 restated for issuance: the manifest exists only after a
      // recorded passing gate decision for this plan version.
      const passing = await repo.findPassingGateDecision(production.id, planVersion.id);
      if (!passing) return err("gate_not_passed", "manifest issuance requires a recorded passing gate decision");

      const plan = planVersion.planDocument as {
        sceneCount: number;
        shotCount: number;
        modelSelections: ProductionManifest["modelSelections"];
        workflowSelections: ProductionManifest["workflowSelections"];
        computeEstimate: ProductionManifest["computeEstimate"];
        rights: ProductionManifest["rights"];
        safety: { moderationRequired: boolean };
      };
      const manifest = buildManifest({
        organizationId: production.orgId,
        productionId: production.id,
        approvedBy: actor.operatorId,
        sceneCount: plan.sceneCount,
        shotCount: plan.shotCount,
        modelSelections: plan.modelSelections,
        workflowSelections: plan.workflowSelections,
        computeEstimate: plan.computeEstimate,
        rights: plan.rights,
        safety: plan.safety,
        plan: planVersion.planDocument,
      });
      const latest = await repo.findLatestManifestVersion(production.id);
      const nextVersion = (latest?.versionNumber ?? 0) + 1;

      const version = await persistAndAudit<ManifestVersionRecord>(
        actor,
        "production.manifest_issued",
        "manifest_version",
        (m) => ({ targetId: m.id, metadata: { productionId: m.productionId, versionNumber: m.versionNumber } }),
        async (tx) => {
          const created = await tx.insertManifestVersion({
            orgId: actor.organizationId,
            productionId: production.id,
            planVersionId: planVersion.id,
            versionNumber: nextVersion,
            manifestDocument: manifest,
            issuedBy: actor.operatorId,
          });
          await tx.updateProduction(production.id, { currentManifestVersionId: created.id });
          return created;
        },
      );

      await emit(
        "production.updated",
        { entityType: "manifest_version", productionId: production.id, manifestVersionId: version.id, versionNumber: version.versionNumber },
        { organizationId: actor.organizationId, projectId: production.projectId, productionId: production.id },
      );
      return { ok: true, value: version };
    },
  };
};

type ProductionRecordShape = {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  kind: ProductionKind;
  currentPlanVersionId: string | null;
  currentManifestVersionId: string | null;
  status: ProductionStatus;
  createdAt: string;
  updatedAt: string;
};

/** The existing pure gate, injected as the default ProductionGate. */
const evaluateGate = (input: Parameters<ProductionGate>[0]) => evaluateProductionGate(input);

import { evaluateProductionGate } from "./gate";
