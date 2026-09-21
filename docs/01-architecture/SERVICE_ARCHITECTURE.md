# Service Architecture

> **Bootstrap draft derived from approved foundation and operator architecture brief — pending human review**

**Document Status.** This document is an **architectural specification** — the canonical
service/module architecture for the Stratifit Platform, derived from the approved
DOMAIN_MODEL.md and the implemented foundation. It is a bootstrap draft pending human
review. **Implementation must wait for human review and approval of this document.**
No code, database schema, migration, API, worker, or infrastructure change is made or
authorized by this document; everything here describes boundaries for future phases.

## 1. Purpose

DOMAIN_MODEL.md defined *what* the platform's domain is (17 bounded contexts, 24
aggregate roots, state machines, provenance, invariants). This specification defines
*where that domain lives in code and runtime*: which capabilities are shared packages,
domain modules, orchestration modules, application feature modules, workers, or
infrastructure adapters; which boundaries are transactional; which communicate through
events; who may call whom; where trust boundaries sit; and how the modular monorepo
can later be extracted into deployable services **without rewriting the domain model**.

The core decision, restated from the approved plan:

**MODULAR MONOREPO FIRST.** A bounded context is a domain boundary. A bounded context
is **NOT** automatically a deployable service. The dependency direction is and remains:

```
contracts
    ↓
packages
    ↓
in-process services/modules
    ↓
applications
```

## 2. Architectural Principles

1. **Modular monorepo first.** No speculative microservices; extraction only for real
   operational reasons (PRINCIPLES 15).
2. **One-way dependency direction.** `contracts ← packages ← services ← apps`.
   Packages never import services or apps; services never import applications.
3. **Module = transaction boundary.** A module owns its tables; there are no
   cross-module database transactions and no cross-module foreign-table writes.
   Cross-module coordination uses ID references, narrow read APIs, and events.
4. **Exactly one owner per persisted concept.** Every table family has one owning
   module (or owning shared package). No shared-table ownership.
5. **Invariants live with their scope.** Aggregate invariants inside the owning
   module; cross-aggregate invariants in named domain services (the Production Gate,
   publishing checks, the verification rule); infrastructure invariants at adapters.
6. **Vendors only behind interfaces.** RunPod, ComfyUI, FFmpeg, Supabase, email, and
   social platforms appear only inside adapter implementations. Domain modules depend
   on package interfaces (`ComputeProvider`, `ModelAdapter`, `WorkflowRuntime`,
   `StorageProvider`, `PlatformAdapter`, `EventPublisher`) — never on vendor SDKs.
7. **Public-safe is an explicit, opt-in classification.** A module is reachable from
   Stratifit Media only if declared `public-service`. The default classification is
   `internal`. This preserves and strengthens the already lint-tested Media blocklist.
8. **Events communicate; transactions own.** The existing `@stratifit/events`
   contract (`EventPublisher`, `DomainEventEnvelope`, `DomainEventName`,
   `idempotent` handlers) is the only event spine. No second event system.
9. **Extraction is justified, never assumed.** Justification criteria: scaling,
   workload isolation, security, GPU adjacency, latency, operational independence,
   deployment independence, specialized infrastructure. Never "a bounded context
   exists."
10. **Secrets never cross module boundaries.** Credentials are injected into adapters
    at construction, server-side only. No domain record, event payload, or API
    response ever contains provider, GPU, worker, or storage-admin secrets.

## 3. Application Architecture

Two separate applications over the shared platform core, unchanged from the
foundation:

| Application | Role | Contents |
|---|---|---|
| `apps/stratifit-control` | Internal operator application | Operator UI; **internal BFF/API** (server route handlers); internal feature modules (dashboard, productions, publishing control, admin — later CMS, editorial, campaigns, live ops); access to authorized internal domain capabilities behind `@stratifit/permissions` capability checks |
| `apps/stratifit-media` | Public audience application | Audience UI; **public BFF/API** (server route handlers calling only `public-service` modules); public-safe contracts and packages only |

- BFF/API layers live **inside** each app as Next.js server route handlers until a
  second consumer justifies a standalone gateway (Open Question 2).
- Control feature areas such as CMS and Editorial are **application feature modules**
  — UI + orchestration over domain modules. They are never services and never own
  domain tables.
- Both apps resolve identity server-side only; the browser is never trusted
  (PRINCIPLES 14; SYSTEM_ARCHITECTURE security boundaries).

## 4. Layer Architecture

Seven layers, with responsibility and allowed dependency direction:

| Layer | Contents | Responsibility | May depend on |
|---|---|---|---|
| **A. Applications** | `apps/stratifit-control`, `apps/stratifit-media` | UI, BFF/API, feature modules, composition of modules + adapters (server-side) | Services, packages |
| **B. Public/Internal BFF-API** | Server route handlers inside each app | Request validation, identity resolution, capability/verification enforcement, calls into modules | Services (per boundary rules), packages |
| **C. Domain/Application services (in-process modules)** | `services/*` libraries | Own aggregates, enforce invariants, own persistence of their table families, emit/consume events | Packages, other services (per dependency graph) |
| **D. Shared packages** | `packages/{contracts,auth,permissions,events,storage,database,ai,workflows,compute,ui}` | Contracts, pure rules, abstractions, vendor-free registries, UI primitives | Contracts, other packages |
| **E. Infrastructure adapters** | Adapter implementations living inside packages/services behind interfaces | Talk to external systems (RunPod, object storage, email, social platforms, FFmpeg, LLM endpoints); hold injected credentials | Package interfaces only |
| **F. Background workers** | Future containers (Phase 3+): generation executor, media-processing executor, publication delivery, notification fan-out, QC automation | Execute jobs; **own no domain state** — all state stays in module-owned tables | Module public APIs, packages |
| **G. External providers** | RunPod, Supabase, object storage, LLM endpoints, social platforms, email | External systems | Reached only through E |

Dependency direction is strictly downward: A → B → C → D → E → G, with F sitting
outside the request path (F → C/D, never C → F directly; the Job Engine module in C
enqueues, workers in F execute).

## 5. Bounded Context → Module Mapping

All 17 bounded contexts from DOMAIN_MODEL.md §4, each with exactly one primary owner.
Most contexts map 1:1 to a module; the exceptions are explained. **No directory is
created merely for symmetry** — the two modules marked ✅ exist today; the rest are
future in-process libraries created phase by phase as features require them.

| # | Bounded Context | Owner module | Rationale |
|---|---|---|---|
| 1 | Identity & Tenancy | `services/identity` (future) | Orgs, teams, memberships, operators, audience users, verification requirements. Owns the tenancy spine upstream of all contexts. `packages/auth` remains the **pure rules** layer (identity kinds, verification decision); durable identity state lives here. Audience-user row ownership is assigned here (resolving the context-1/context-12 overlap — see §11 and Contradictions Check). |
| 2 | Production | `services/production-engine` ✅ | Exists. Per SUGGESTION 1, Planning Engine and Project Management are sub-modules here (they share the production aggregate family: projects, productions, templates, plan versions, gate decisions, manifests). |
| 3 | Creative / Story | `services/creative` (future) | Universe→World→Story→Season→Episode→Scene→Shot, scripts, narrative catalog, world rules, timelines. Own aggregates 6–7 — deliberately **not** folded into production-engine: DOMAIN_MODEL §7 assigns scenes/shots to their own contexts, referenced by productions. |
| 4 | People (Digital Humans) | `services/people` (future) | Digital humans, characters, personas, AI creators, public profiles, voices + versions, wardrobes + states (aggregates 8–11). Public-profile *records* are owned here; they are **created/updated only through the publication flow** (publishing → people API), preserving "a public profile is a publication-facing identity." |
| 5 | Rights & Consent | `services/rights` ✅ | Rights owners, grants, status events, requirements declarations (aggregate 12); fail-closed evaluation seam (Stage 2.21 foundation + Stage 2.22 declaration family; ports UNWIRED at 2.21/2.22 — Stage 2.23 Publishing cutover DONE (D2.23-1: `PublicationRightsPort` injected; approve/retry gated on `enforce` requirements only, `record_only` observes, absent declarations vacuous; People cutover deferred to 2.24). |
| 6 | Asset Domain | `services/assets` (future) | Assets, asset versions, lineage DAG (aggregate 13). Registers generation outputs and media-processing derivatives via its API so lineage edges stay intact. |
| 7 | Generation | `services/generation` (future) | Generation records + immutable provenance (aggregate 14). Provenance is a **query capability** over generation/asset immutable records (§6), not an owner — no separate provenance module. |
| 8 | Catalog (Model/Workflow) | `packages/ai` ✅ + `packages/workflows` ✅ | Registries, routers, adapters already exist as shared packages. Their durable rows (`models`, `model_versions`, `workflows`, `workflow_versions`) are owned by the same packages via `packages/database` repositories — keeping vendor-free registry logic and its persistence in one place. |
| 9 | Job / Compute | `services/jobs` (future) | Jobs, dependencies, attempts, compute requirements/usage (aggregate 17). Workers are infrastructure (Layer F), not owners. |
| 10 | QC | `services/quality-control` (future) | Checks, results, issues, reviews (aggregate 18). Own module rather than part of production-engine because QC gates assets, generations, productions **and** publications (SUGGESTION 2). |
| 11 | Publishing | `services/publishing-engine` ✅ | Exists. Publications, versions, distribution refs (aggregate 19); exposes the public read API consumed by Media. |
| 12 | Public Media & Audience | `services/audience` (future) | Public content, audience profiles, watch progress, experiments/variants/assignments (aggregates 3, 20, 24). Public content rows are created only by consuming `publication.published`. Experimentation lives here because variant assignment happens on the public request path; analytics only receives outcome references. Notifications are split out (row below) per the plan. |
| 13 | Social Graph | `services/social` (future) | Follows, likes, comments, shares, saves — asymmetric, referencing public content/profiles only. |
| 14 | Messaging & Leads | `services/messaging` (future) | Conversations, messages, service inquiries, leads, follow-ups (aggregates 21–22). The Communication Engine is an **orchestration sub-module** here (owns no tables; drives AI replies via `packages/ai`). |
| 15 | Advertising | `services/advertising` (future) | Brands, products, campaigns, creatives, variants (aggregate 23). |
| 16 | Analytics | `services/analytics` (future) | Analytical-event intake (`analytics.received`) + read models. Intake + read models **only** — per the approved plan it owns no domain aggregates. |
| 17 | Admin & Audit | `services/admin-audit` (future) | Permission grants, audit log. Cross-cutting consumer of audit-relevant transitions (write path per Open Question 10). |

Module count is deliberately conservative: 21 planned module directories (2 existing,
19 future), all in-process libraries at Stage 1 — zero new deployables.

## 6. Capability Classification

All 31 capabilities from the approved plan, each classified:

| Capability | Classification | Home | Extraction stage |
|---|---|---|---|
| AI Director | Orchestration module | `services/ai-director` (future; owns no tables — consumes `packages/ai` LLM adapters + production-engine outputs, produces schema-validated plans) | Stage 1; Stage 2 candidate (LLM latency) |
| Planning Engine | Domain sub-module | inside `services/production-engine` | Never (in-process) |
| Production Engine | Domain module (exists) | `services/production-engine` | Stage 4 only if multi-org scale demands |
| Production Gate | Pure domain function (exists) | `services/production-engine` (`evaluateProductionGate`) | Never |
| Model Registry | Shared package (exists) | `packages/ai` | Never (library) |
| Model Router | Shared package (exists) | `packages/ai` | Never |
| Model Adapter Layer | Shared package + adapters (exists) | `packages/ai` | Never; new adapters are additive |
| Workflow Registry | Shared package (exists) | `packages/workflows` | Never |
| Workflow Runtime | Shared package + runtime adapters (exists) | `packages/workflows` | Stage 3 candidate (runtime gateway) |
| Compute Manager | Shared package (exists) | `packages/compute` | Never (library); gateway at Stage 3 if multi-tenant GPU ops |
| Job Engine | Domain module | `services/jobs` (future) | Stage 2 (its executors are workers) |
| Worker Runtime | Worker (infrastructure) | `infrastructure/` from Phase 3 | Stage 2 |
| Media Processing | Domain module + worker executor | `services/media-processing` + worker | Module Stage 1–2; executor Stage 2–3 |
| Quality Control | Domain module | `services/quality-control` (future) | Stage 1; automation worker Stage 2 |
| Publishing Engine | Domain module (exists) | `services/publishing-engine` | Stage 1; delivery worker Stage 2 |
| Messaging Engine | Domain module | `services/messaging` (future) | Stage 1 |
| Communication Engine | Orchestration module | inside `services/messaging` (worker-hosted from Phase 6) | Stage 2 candidate |
| Analytics Engine | Domain module | `services/analytics` (future) | Intake Stage 3–4 candidate |
| Recommendation Engine | Domain module (read-model consumer) | `services/recommendations` (future) | Stage 3–4 candidate |
| Notification Engine | Domain module | `services/notifications` (future) | Fan-out worker Stage 2 |
| Search | Domain module | `services/search` (future) | Stage 3–4 candidate |
| Advertising/Campaign Engine | Domain module | `services/advertising` (future) | Stage 1 |
| Live Engine | Domain module | `services/live` (future, Phase 7) | Stage 3+ (realtime infra) |
| CMS | Application feature module | `apps/stratifit-control` | Never — never a service |
| Editorial | Application feature module | `apps/stratifit-control` | Never |
| Audience | Domain module | `services/audience` (future) | Stage 1 |
| Social Graph | Domain module | `services/social` (future) | Stage 1 |
| Rights/Consent | Domain module | `services/rights` ✅ | Stage 2.21 foundation + Stage 2.22 requirements declarations; Stage 2.23 Publishing cutover complete (People/QC/Production still unwired) |
| Asset Management | Domain module | `services/assets` (future) | Stage 1 |
| Provenance | Query capability (not an owner) | over Generation/Asset immutable records | Never |
| Project Management | Domain sub-module | inside `services/production-engine` | Never (in-process) |

## 7. Service Ownership Matrix

For every major module: responsibility, owned state, aggregate ownership, read
dependencies, write boundaries, events emitted, events consumed, security
classification, exposure, and extraction stage. (✅ = implemented today.)

| Module | Responsibility | Owned state (table families) | Aggregates | Reads (by ID / read API) | Writes | Emits | Consumes | Security | Exposure | Stage |
|---|---|---|---|---|---|---|---|---|---|---|
| `services/identity` | Tenancy + identity spine; session→identity resolution | organizations, teams, memberships, operators, audience_users, verification_requirements | 1, 2, 3 | auth subject refs (external) | own tables only | (future: membership.* events) | — | Internal | Internal (identity resolution API used server-side by both apps' BFFs) | 1 |
| `services/production-engine` ✅ | Planning, gating, manifests, project management | projects, productions, production_templates, production_plan_versions, gate_decision_records, manifest_versions | 4, 5 | rights verdicts; creative structure; people refs; catalog compatibility; compute estimates | own tables; enqueue via jobs API | production.created / .updated / .approved | qc.*, rights.* (future, for re-gating) | Internal | Internal (Control only) | 1 |
| `services/creative` | Narrative structure + world building | universes, worlds, world_rules, timeline_entries, stories, seasons, episodes, scenes, shots, scripts, narrative catalog | 6, 7 | people, assets (visual refs) | own tables only | (future: story.* events) | — | Internal | Internal | 1 |
| `services/people` | Synthetic people + creator operations | digital_humans, characters, personas, ai_creators, creator_profiles, voices, voice_versions, wardrobes, wardrobe_states | 8–11 | assets (appearance refs), rights (refs) | own tables; profile rows written only via publication flow | (future: creator.published/.unpublished) | publication.published (to create/republish public profiles via its own API) | Internal | **Public-safe fragment**: public profile read API (`public-service` fragment — see §13) | 1 |
| `services/rights` | Usage authorization, fail-closed evaluation | rights_owners, rights_grants, rights_status_events | 12 | people/asset refs | own tables only | (future: rights.granted/.revoked/.expired) | — | Internal | Internal (verdict API for gate + publishing) | 1 |
| `services/assets` | Media metadata, versions, lineage | assets, asset_versions, asset_lineage | 13 | generation refs, storage refs | own tables only | asset.created, asset.approved, (future: asset.rejected) | generation.completed (register outputs via own API call from generation) | Internal | Internal (published version refs readable by public-safe modules via read API) | 1 |
| `services/generation` | AI executions + immutable provenance | generations | 14 | manifest versions, catalog versions, assets (inputs) | own tables; register outputs via assets API | generation.created / .completed / .failed | job.* (attempts/results) | Internal | Internal | 1 |
| `packages/ai` | Model registry/router/adapters (durable rows) | models, model_versions | 15 | — | own tables only | — | — | Internal | Internal | 1 |
| `packages/workflows` | Workflow registry/runtimes (durable rows) | workflows, workflow_versions | 16 | — | own tables only | — | — | Internal | Internal | 1 |
| `services/jobs` | Executable work: queue, dependencies, attempts, idempotency, compute accounting | jobs, job_dependencies, job_attempts, compute_requirements, compute_usage | 17 | subjects by ID | own tables only | job.created / .started / .progress / .completed / .failed / .cancelled | worker completions (via attempt API) | Internal | Internal | 1 (module); 2 (workers) |
| `services/quality-control` | Quality decisions gating assets/generations/productions/publications | qc_checks, qc_results, qc_issues | 18 | subjects by ID (assets, generations, productions, publications) | own tables only | (future: qc.approved / .rejected) | asset.created, generation.completed | Internal | Internal | 1 |
| `services/media-processing` | Derivative logic (thumbnails, posters, trailers, transcodes, subtitles) | none (writes via assets API) | — | asset versions | **none direct** — derived versions created through assets API (lineage preserved) | (future: media.derivative-created) | job.* (media.process) | Internal | Internal | 1 (logic); 2 (executor) |
| `services/publishing-engine` ✅ | Distribution of approved content; public read API | publications, publication_versions, distribution_references | 19 | QC verdicts, asset versions, people (profile snapshots via API) | own tables; profile updates via people API | publication.created / .published / .failed, (future: .unpublished) | qc.approved (future) | Internal | **Public read API** (`public-service`) | 1; delivery worker 2 |
| `services/audience` | Public content + audience platform state + experiments | public_content, audience_profiles, watch_progress, experiments, experiment_variants, experiment_assignments | 3 (state), 20, 24 | published asset versions, public profiles | own tables only | (future: experiment.* events) | publication.published | Internal | **Public-service** | 1 |
| `services/social` | Asymmetric audience relationships | follow_graph, likes, comments, shares, saves | — | public content/profile refs, audience users | own tables only | (future: social.* events) | — | Internal | **Public-service** | 1 |
| `services/notifications` | Notification records + fan-out | notifications | — | event payloads (recipient refs) | own tables only | (future: notification.sent) | message.created, publication.published, social.* (future) | Internal | **Public-service** (read own notifications) | 1; fan-out worker 2 |
| `services/search` | Public search over read models | search indexes/read models | — | public read models only | own indexes only | — | publication.published, social.* | Internal | **Public-service** | 1 (Postgres FTS); 3–4 (engine) |
| `services/recommendations` | Recommendations from analytical read models | recommendation read models | — | analytics read models, public content | own read models only | — | analytics intake | Internal | **Public-service** | 1 (simple); 3–4 |
| `services/analytics` | Analytical-event intake + read models | analytical event store, read models | — | ID references from all contexts | own tables only | analytics.received | all modules' events | Internal | Internal (read models to public-safe modules via read API) | 1 |
| `services/messaging` | Conversations, messages, leads; communication orchestration | conversations, messages, service_inquiries, services, leads, lead_follow_ups | 21, 22 | public profiles (comms config), audience users | own tables only | conversation.created, message.created, message.read, (future: lead.created/.assigned) | — | Internal | **Public conversation surface** (`public-service` fragment: conversation read/send for verified audience users); Control inbox internal | 1; communication worker-hosted 2 |
| `services/advertising` | Brands, campaigns, creatives | brands, products, campaigns, campaign_creatives, campaign_variants | 23 | productions (optional creative pipeline), assets | own tables only | (future: campaign.created) | — | Internal | Internal | 1 |
| `services/live` | Live programs (control plane) | live schedules/programs (Phase 7) | — | productions, public content | own tables only | (future: live.*) | — | Internal | Public playback via audience/public content | 1 (Phase 7) |
| `services/admin-audit` | Permission grants + audit trail | audit_log | — | everything (read) | **append-only via its public API** (the one sanctioned cross-module write — see Open Question 10) | — | audit-relevant events | Internal | Internal (Control admin) | 1 |
| `services/ai-director` | AI planning orchestration (owns no tables) | none | — | production-engine types, packages/ai | **none** — produces schema-validated plan drafts for production-engine | — | — | Internal | Internal | 1 |

**Reading the matrix:** no shared-table ownership anywhere; cross-module writes never
touch foreign tables — they go through the owning module's public API (the
sanctioned examples: generation → assets for output registration; publishing →
people for profile snapshots; all modules → admin-audit for audit append).

## 8. Service Dependency Graph

```
                       ┌──────────────────────────── apps (Layer A/B) ────────────────────────────┐
                       │  stratifit-control ──► ALL internal modules + all packages               │
                       │  stratifit-media   ──► contracts + {auth, permissions, ui, events}       │
                       │                        + public-service modules ONLY                     │
                       └──────────────────────────────┬───────────────────────────────────────────┘
                                                      ▼
  ┌──────────────────────────────────── in-process modules (Layer C) ────────────────────────────────────┐
  │ production-engine ──► rights, creative, people, jobs, assets(read), ai, workflows, compute           │
  │ ai-director ──► production-engine(types), ai                                                         │
  │ jobs ──► database, events, compute                          [workers call jobs' attempt API]         │
  │ generation ──► assets(API), ai, workflows, compute, jobs(subjects)                                   │
  │ quality-control ──► assets(read), generation(read), events                                           │
  │ media-processing ──► assets(API)                                                                     │
  │ publishing-engine ──► quality-control(read), assets(read), people(API), audience(?)                  │
  │ audience ──► assets(read), people(read), analytics(read models)                                      │
  │ social ──► audience(read), identity(IDs)                    notifications ──► events, identity(IDs)  │
  │ messaging ──► people(read), audience(read), ai, events                                               │
  │ search / recommendations ──► audience(read), analytics(read models)                                  │
  │ advertising ──► production-engine(read), assets(read)       analytics ──► events (intake)            │
  │ identity ──► database, auth                         admin-audit ──► database  [all modules ──► admin-audit append API]
  └──────────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                                 ▼
  ┌───────────────────────────── shared packages (Layer D) ─────────────────────────────────────────────┐
  │ contracts ◄── everything.  auth, permissions, events, ui ◄── services + apps                         │
  │ database ◄── services + registry packages        storage ◄── services (StorageProvider)              │
  │ ai ◄── production-engine, generation, messaging  workflows ◄── production-engine, generation, workers │
  │ compute ◄── production-engine, jobs, generation                                                       │
  └──────────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                                 ▼
                     Infrastructure adapters (E) ──► External providers (G)
                     [RunPod · object storage · email · LLM endpoints · social platforms · FFmpeg]
```

**Forbidden dependencies** (each mechanically or review-enforced):

| Forbidden | Enforcement |
|---|---|
| packages → services or apps | dependency direction (ESLint boundaries; CI) |
| contracts → anything internal | contracts depend only on zod |
| services → applications | dependency direction |
| `publishing-engine` ↔ `production-engine` (either direction) | existing ESLint public-service rule; preserves PRINCIPLES 9 |
| `media-app` → internal-package / internal-service | existing tested ESLint blocklist |
| any module → vendor SDKs | vendor code only in Layer E adapters |
| social / notifications / search / recommendations → production internals | public-service allowlist + review |
| client code → credentials | secrets injected server-side at composition roots only |

**Synchronous vs asynchronous:** solid arrows above are synchronous in-process calls
(§9); the async dimension (§10) adds no new dependencies — event consumers depend on
the events contract, not on emitting modules.

**Cycle check:** the graph is a DAG. The only bidirectional-looking pairs are
mediated: `publishing → people` (API) with `people` consuming `publication.published`
as an *event* (no import of publishing); `jobs` ↔ workers via the attempt API +
`job.*` events (workers are Layer F, outside the module graph). **No unexplained
circular dependency exists.**

## 9. Synchronous Communication

Stage 1 uses typed in-process function calls. Rules:

- **app → module**: BFF route handlers call a module's public API (narrow typed
  exports from its `index.ts`). Apps never reach past the public API into module
  internals, and never touch infrastructure directly.
- **module → package**: modules depend on package interfaces (`StorageProvider`,
  `ComputeProvider`, `ModelAdapter`, `WorkflowRuntime`, `EventPublisher`), never on
  vendor SDKs.
- **authorized cross-module call**: only along the dependency graph (§8), only via
  the callee's public API, and only for operations the callee owns. Sanctioned
  cross-module write APIs: `assets.registerVersion` (generation outputs,
  media derivatives), `people.publishProfileSnapshot` (publishing), `jobs.enqueue`
  (production-engine post-approval), `admin-audit.append` (all modules, audit).
- **read APIs**: cross-module reads go by ID reference or the owning module's read
  API (e.g., `publishing-engine`'s existing `PublicationReader` consumed by Media).
- **validation/invariant enforcement**: at the owning module (aggregate invariants)
  and in domain services for cross-aggregate rules (gate, publishing checks,
  verification rule). BFF layers validate transport shape only — domain invariants
  are never enforced client-side.
- **Narrow APIs**: modules export the minimum surface needed by the graph. No module
  exposes "everything" (Open Question 8 covers the extraction-facing convention).
- A per-app **server-only composition root** wires modules with their adapters
  (SUGGESTION 6): this is where credentials are injected, and the only place.

## 10. Asynchronous Communication

The **only** event system is the existing `@stratifit/events` contract:

- `EventPublisher` (in-process implementation today) + `DomainEventEnvelope`
  (eventId idempotency, name, sequence, occurredAt, correlation set, validated
  payload) + `DomainEventName` names + `idempotent` handler wrapper.
- **Event ownership**: the emitting module owns its event names. Consumers subscribe
  via the publisher; they depend on the envelope contract, never on the emitting
  module's code.
- **Idempotency boundary**: handler-level, keyed by eventId (the existing
  `idempotent` wrapper; durable dedup table arrives with the outbox seam).
- **Documented chains** (consumers listed own their reactions):
  - `generation.completed` → QC automation enqueues checks; (output registration is
    synchronous via the assets API for transactional integrity)
  - `asset.approved` → publishing eligibility evaluation
  - `publication.published` → audience creates public content; notifications;
    people re-publishes profile snapshots (via its own API)
  - `message.created` → notifications fan-out; communication-engine trigger;
    lead classification
  - `analytics.received` → read-model updates
  - `production.approved` → jobs enqueue (synchronous call) + audit append
- **Known limitation, documented as architecture**: the in-process publisher has no
  transactional/outbox guarantee. The **outbox table becomes the transport seam at
  Phase 3** (SUGGESTION 3), when durable events arrive with the Job Engine — the
  `EventPublisher` interface does not change.
- **Event-name extensions** (`asset.rejected`, `qc.approved`, `rights.*`,
  `lead.*`, `publication.unpublished`, `creator.published`, … as enumerated in
  DOMAIN_MODEL §35) require extending the `DomainEventName` contract — a contract
  change gated on approval, never a second naming convention.

## 11. Persistence (Database) Ownership

One Supabase-managed PostgreSQL database initially (per the approved plan and
DOMAIN_MODEL §38). **No schema or migrations are created by this document.**

Rules:

- **One owner per table family** — the table below assigns every DOMAIN_MODEL §38
  entity family to exactly one owning module/package.
- **No foreign-module writes.** Cross-module reads by ID or read API; cross-module
  coordination through events where appropriate; **no cross-module distributed
  transactions**.
- `packages/database` remains the **sole Drizzle schema owner** (SUGGESTION 5);
  modules own *conceptual* table families, expressed through it.

| Owner | Table families (from DOMAIN_MODEL §38) |
|---|---|
| `services/identity` | organizations, teams, memberships, operators, audience_users, verification_requirements |
| `services/creative` | universes, worlds, world_rules, timeline_entries, stories, seasons, episodes, scenes, shots, scripts, narrative catalog (locations/props/organizations/vehicles) |
| `services/people` | digital_humans, characters, personas, ai_creators, creator_profiles, voices, voice_versions, wardrobes, wardrobe_states |
| `services/rights` | rights_owners, rights_grants, rights_status_events |
| `services/assets` | assets, asset_versions, asset_lineage |
| `services/generation` | generations |
| `packages/ai` | models, model_versions |
| `packages/workflows` | workflows, workflow_versions |
| `services/production-engine` | projects, productions, production_templates, production_plan_versions, gate_decision_records, manifest_versions |
| `services/jobs` | jobs, job_dependencies, job_attempts, compute_requirements, compute_usage |
| `services/quality-control` | qc_checks, qc_results, qc_issues |
| `services/media-processing` | — (no tables; writes derived versions via assets API) |
| `services/publishing-engine` | publications, publication_versions, distribution_references |
| `services/audience` | public_content, audience_profiles, watch_progress, experiments, experiment_variants, experiment_assignments |
| `services/social` | follow_graph, likes, comments, shares, saves |
| `services/notifications` | notifications |
| `services/messaging` | conversations, messages, service_inquiries, services, leads, lead_follow_ups |
| `services/advertising` | brands, products, campaigns, campaign_creatives, campaign_variants |
| `services/analytics` | analytical event store, read models |
| `services/search` / `services/recommendations` | their own indexes/read models |
| `services/admin-audit` | audit_log |
| platform (packages/database) | platform_config (foundational, unchanged) |

**Ownership resolution recorded here:** DOMAIN_MODEL lists Audience User in both
context 1 (Identity & Tenancy) and context 12 (Public Media & Audience). The
`audience_users` rows are owned by `services/identity` (tenancy spine, upstream of
all); `services/audience` references them by ID and owns audience *platform state*
(profiles, watch progress, experiments). One row family, one owner.

Viewing/watch *events* are analytical (DOMAIN_MODEL §21) and flow to the analytics
intake; `watch_progress` is transactional audience state and stays in
`services/audience`.

## 12. Control Architecture

Stratifit Control may access everything internal: the production family
(production-engine, creative, people, rights, assets, generation, jobs,
quality-control, media-processing), catalog packages (ai, workflows), compute,
publishing control, the messaging inbox with human takeover
(`messaging.takeover`), leads (`lead.assign`), advertising, analytics, admin/audit.
CMS, editorial, campaign operations, and live ops are **application feature modules**
inside Control over those domain modules — they never own tables and never become
services. Every internal API route enforces capability checks server-side via
`@stratifit/permissions`; operator identity is resolved from server session state
(never client claims) via the identity module's resolution API.

## 13. Media Architecture

Stratifit Media may access **only**:

- public-safe contracts (`@stratifit/contracts`: audience rules, ID/verification
  types, manifest/event types read-only);
- the public-safe packages `{auth, permissions, ui, events}`;
- modules explicitly classified **`public-service`**: the publishing-engine's public
  read API today; then audience, social, messaging (public conversation surface),
  notifications, search, recommendations as they are built.

The default classification is **`internal`** — public exposure is **opt-in**: a new
module is unreachable from Media until it is explicitly registered in the
`public-service` element class of the ESLint boundary configuration (SUGGESTION 4
codifies the convention). The tested Media blocklist is preserved verbatim: Media
MUST NOT directly access `packages/compute`, `packages/ai`, `packages/workflows`,
`packages/database`, `packages/storage`, `services/production-engine`, the worker
runtime, RunPod, ComfyUI, infrastructure credentials, or internal production APIs.
Media sees public slugs/handles only — never internal production entity IDs.

**Public-safe fragments:** `services/people` and `services/messaging` are internal
modules that each expose one narrow public-safe read/write surface (public profile
read; verified-audience conversation send/read). The fragment — not the module — is
registered public-safe; the modules' internals stay internal. This is the explicit
mechanism for "public-safe functionality of an otherwise internal module."

## 14. AI Architecture

Unchanged from SYSTEM_ARCHITECTURE:

```
Production Engine / AI Director / Communication Engine
    → Capability Contract (@stratifit/contracts)
    → Model Router (@stratifit/ai)
    → Model Adapter (@stratifit/ai)
    → Selected Model (provider details in adapter configuration)
```

The AI Director and the Communication Engine are **consumers** of `packages/ai`,
producing schema-validated outputs; deterministic modules (gate, permissions,
verification) enforce authorization. LLM endpoints are adapter configuration
injected at the composition root. AI never holds credentials, never bypasses gates,
never mutates immutable provenance (PRINCIPLES 4).

## 15. Compute Architecture

```
Job Engine (services/jobs)
    → Compute Manager (packages/compute)
    → ComputeProvider
    → provider (RunPod today — stub; future providers additive)
```

and

```
Worker → Workflow Runtime (packages/workflows) → Compute (packages/compute)
```

RunPod remains a **provider reference string** in domain records; ComfyUI remains a
**runtime type** behind the abstraction. Neither name appears in any domain module.
No provider credentials exist outside adapter constructors.

## 16. Worker Architecture

Workers are **execution infrastructure, not domain owners** (Layer F). Future
workers: generation executor (workflow runtime + compute provider), media-processing
executor (FFmpeg), publication delivery, notification fan-out, QC automation.
Rules: workers call module public APIs to read subjects and record outcomes; **all
state stays in module-owned tables**; **attempts are recorded immutably**; **retries
require idempotency** (idempotency key per job type+target); cancellation is
requested then observed at safe points. Worker definitions and container manifests
live in `infrastructure/` from Phase 3 — nothing worker-related is built now.

## 17. Media Processing Architecture

A future `services/media-processing` module owns derivative *logic* (thumbnails,
posters, trailers, transcodes, subtitles, audio/video processing). FFmpeg runs
**only inside the worker executor** (Layer E/F) — the FFmpeg implementation never
leaks into domain modules, and media-processing domain logic remains separate from
the FFmpeg implementation. Derived asset versions are created **through the Asset
module's API** so lineage DAG edges (`derivation kind`, parent version) are always
preserved. Nothing is implemented in this phase.

## 18. Publishing Architecture

```
Production (approved) → QC → Publishing Engine → PlatformAdapter → Public Content
```

- External platforms (YouTube, TikTok, Instagram, Facebook) remain **adapters**
  behind the existing `PlatformAdapter` interface; the StratifitMedia adapter exists
  today.
- **Failure isolation** is preserved: an adapter failure marks the
  publication/distribution attempt `failed` and never invalidates the production
  master (PRINCIPLES 13; DOMAIN_MODEL invariant 5). Re-delivery is a publication
  state transition, not a production event.
- Publishing consumes only approved subject references and cannot reach production
  internals — mirrored mechanically by the existing ESLint rule.

## 19. Messaging Architecture

Separation of concerns:

| Concern | Home |
|---|---|
| Public messaging surface (verified audience send/read) | `services/messaging` public-safe fragment, exposed via Media BFF with `@stratifit/auth` verification enforcement |
| Messaging domain (Conversation, Message, Lead aggregates) | `services/messaging` |
| Communication orchestration (AI Communication Engine) | orchestration sub-module of `services/messaging` — consumes `message.created`, produces AI drafts via `packages/ai`; **never bypasses permissions or domain state** (it writes messages through the messaging module's own API, author kind `ai`) |
| Human takeover | operator action via Control (`messaging.takeover`), recorded as an assignment/audit event; subsequent messages carry author kind `human` |
| Control inbox | Control feature module over the messaging module's internal API |
| Notifications | `services/notifications` consuming `message.created` |
| Leads/service inquiries | `services/messaging` (lead family), exposed to Control (`lead.assign`) |

Message author kinds (`ai | human | system`) come from the existing
`MessageAuthorKind` contract. The communication engine is **not implemented** in
this phase.

## 20. Analytics Architecture

Three separated families, never conflated (DOMAIN_MODEL invariant 15):

1. **Transactional domain state** — owned by aggregates in their modules.
2. **Domain events** — the `@stratifit/events` spine (§10).
3. **Analytical events** — append-only intake (`analytics.received`) into
   `services/analytics`, which maintains read models; never written back into
   domain state.

The **Recommendation Engine consumes analytical/read models only** — it never
couples to production transactional state. The Media BFF reads public-safe read
models through public-service read APIs (Open Question 5 covers the read-model
store decision). No warehouse is built in this phase.

## 21. Advertising Architecture

`services/advertising` owns campaign state (brands, products, campaigns, briefs,
budgets, targets, creatives, variants). Creative production **may use the normal
production pipeline** (optional production ref); **public campaign content must go
through publishing** like everything else — there is no advertising-specific
publication path. Performance references are analytics IDs keyed by
campaign/creative/publication.

## 22. Live Architecture

Live is a **future domain module** (`services/live`, Phase 7 per ROADMAP) owning
live program scheduling and control-plane state. Separation maintained:
live control-plane state (internal, this module) ≠ production (live productions go
through the normal gate/manifest pipeline) ≠ public playback/distribution (public
content via publication). The realtime transport decision (WebSocket vs SFU vs
hosted platform) is **explicitly deferred** — not prematurely decided (Open
Question list of DOMAIN_MODEL and the deployment stages keep this open).

## 23. Security Boundaries

Two trust chains, exactly as in SYSTEM_ARCHITECTURE and DOMAIN_MODEL §36:

```
Public Browser → Stratifit Media → Media BFF → public-safe services → Data
Internal Operator → Stratifit Control → authorized internal APIs → domain services
                  → Compute Manager → Workers (GPU)
```

- The browser is never trusted; all authorization and verification enforcement is
  server-side (BFF layer + owning modules).
- Secrets (RunPod credentials, GPU credentials, provider secrets, worker secrets,
  storage-admin credentials, internal service secrets) remain server-side, injected
  at per-app composition roots into adapters only (SUGGESTION 6). They never appear
  in domain entities, event payloads, or API responses.
- Media's reach is the opt-in `public-service` classification (§13).
- Audit-relevant transitions (permission changes, gate/QC/approval decisions,
  revocations, takeovers, lead transitions) flow to `services/admin-audit`
  (write path: Open Question 10).

## 24. Dependency Rules

Enforceable rules and their enforcement mechanisms:

| # | Rule | Enforcement |
|---|---|---|
| 1 | Apps never access infrastructure directly | composition roots are the only injection point; ESLint boundaries + review |
| 2 | Media never accesses internal production infrastructure | existing tested ESLint blocklist (compute, ai, workflows, database, storage, production-engine) |
| 3 | Services never import applications; packages never import services/apps | ESLint boundaries; CI |
| 4 | Services never bypass domain ownership (no foreign-table writes) | ownership matrix (§7/§11); review; future contract tests |
| 5 | Contracts remain dependency-light | contracts depend on zod only; lint import checks |
| 6 | Infrastructure adapters remain behind interfaces | package interface rule; review |
| 7 | Domain modules never import vendor SDKs | ESLint restricted imports; review |
| 8 | Provider-specific code stays at infrastructure boundaries | adapter-file conventions |
| 9 | Historical provenance/version rows remain immutable (append-only) | DOMAIN_MODEL invariants; schema-phase constraints |
| 10 | Public publication happens only through Publishing | publishing-engine is the sole publication path; ESLint rule |
| 11 | Sensitive operations remain server-side | BFF + capability checks; secret-handling rules |
| 12 | Public-safe exposure is opt-in classification | `public-service` element class; SUGGESTION 4 convention |

## 25. Deployment Model

Four stages. **Stage 1 is current state + near-term; nothing later is built now.**

- **Stage 1 — Modular monolith / in-process modules (now → Phase 2):** two Next.js
  apps; all domain modules as in-process libraries invoked from server route
  handlers; in-process events; Supabase Postgres + object storage behind
  `packages/storage`. Zero additional deployables.
- **Stage 2 — Background workers (Phase 3):** Job Engine module + Redis/BullMQ;
  first worker containers (generation executor, media-processing executor,
  publication delivery, notification fan-out); outbox seam for durable events.
- **Stage 3 — High-load infrastructure isolation (Phase 4–5):** workflow-runtime /
  compute gateway isolating provider credentials; media-processing fleet; search
  and analytics intake scale-out if volume demands.
- **Stage 4 — Independent service extraction where justified (Phase 6–7):** domain
  services (messaging/communication, analytics, recommendation) behind the same
  typed module surfaces — extraction without rewrite because modules already own
  their state and expose narrow APIs.

**Extraction criteria (all stages):** scaling; workload isolation; security; GPU
adjacency; latency; operational independence; deployment independence; specialized
infrastructure. **Never** "a bounded context exists."

## 26. Future Service Extraction

Candidates (all **future**, none current):

1. **Worker runtime + media processing** — workload isolation, GPU adjacency
   (certain, Phase 3–4).
2. **Workflow-runtime / compute gateway** — security isolation of provider
   credentials (Phase 4, if multi-tenant GPU operations arrive).
3. **Communication Engine** — long-latency LLM work off the request path
   (Phase 6).
4. **Analytics intake** — write volume (Phase 7).
5. **Search / recommendation engines** — specialized infrastructure (Phase 7, if
   Postgres FTS is insufficient).

**Intentionally in-process, indefinitely:** CMS, Editorial, Project Management,
Provenance queries, Admin/Audit, the Production Gate (pure function), Planning,
Advertising. These gain nothing from distribution and would pay coordination costs.

## 27. Open Questions

Exactly ten. Each: Question / Why it matters / Recommendation / **Decision required:
YES**.

1. **Postgres layout — schema-per-module vs single schema.**
   Question: do modules get separate PostgreSQL schemas, or one schema with
   documented table ownership?
   Why it matters: affects migrations, cross-module query ergonomics, and how
   physically clean future extraction is.
   Recommendation: single schema; ownership documented in §11 and enforced by
   module-code ownership; schemas add friction without adding real boundaries at
   this scale.
   **RESOLVED — Decision 2 approved (Phase 2 decision session):** single `public`
   PostgreSQL schema with documented ownership per §11, plus the explicit
   sub-rule: **no cross-module foreign-key constraints** — FKs only within a
   module's own table family; cross-module references stay loose ID references.

2. **BFF placement — in-app route handlers vs standalone gateway.**
   Question: do Control/Media BFFs stay inside the Next.js apps, or does a shared
   API gateway emerge?
   Why it matters: determines where capability/verification checks live and whether
   a second consumer (mobile, partners) forces extraction.
   Recommendation: in-app until a second consumer exists; the module APIs make
   later extraction mechanical.
   Decision required: YES.

3. **Communication Engine hosting — in-process vs worker from day one.**
   Question: does the AI Communication Engine run inside the request path or as
   worker-hosted work?
   Why it matters: LLM reply latency measured in seconds-to-minutes; in-process
   hosting couples Media UX to AI latency.
   Recommendation: worker-hosted from Phase 6; until messaging exists at all, the
   question is dormant.
   Decision required: YES.

4. **Event transport timing — in-process through Phase 2 vs Redis earlier.**
   Question: does durable event transport (outbox + broker) arrive with the Job
   Engine, or before any durable background work exists?
   Why it matters: the in-process publisher loses events on process death;
   acceptable while everything is transactional, unacceptable once workers exist.
   Recommendation: in-process until Stage 2; outbox table at the seam (SUGGESTION
   3); no broker before workers justify one.
   Decision required: YES.

5. **Media read models — same-Postgres read APIs vs separate read store.**
   Question: do Media-facing reads (home, discover, search, recommendations) hit
   module read APIs on the same Postgres, or a separate read store?
   Why it matters: determines Media's latency/ops profile and how cleanly Media
   survives internal schema evolution.
   Recommendation: same Postgres via read APIs; extract a read store on measured
   load.
   Decision required: YES.

6. **Notification fan-out ownership — one consumer module vs per-domain emitters.**
   Question: does a single notifications module own all fan-out, or does each domain
   emit user-facing notifications directly?
   Why it matters: duplicated notification logic vs a fan-out bottleneck; affects
   invariant 6 (failed notification never rolls back a message).
   Recommendation: single `services/notifications` consuming events (already the
   ownership matrix).
   Decision required: YES.

7. **Search scope and engine at Phase 5.**
   Question: search over content only, or content + creators; Postgres full-text vs
   external engine?
   Why it matters: scope determines whether search can stay a thin read model or
   becomes specialized infrastructure (extraction candidate).
   Recommendation: content + creators, Postgres FTS first; external engine only on
   measured need.
   Decision required: YES.

8. **Module public-API convention — plain typed exports vs explicit interface
   layers.**
   Question: do modules expose plain `index.ts` typed exports, or formal interface
   layers now to ease extraction?
   Why it matters: interface layers add indirection today for a benefit that only
   materializes at extraction.
   Recommendation: typed exports only; introduce interface layers per module at its
   extraction point (the module surface is already narrow).
   Decision required: YES.

9. **Identity resolution ownership — `services/identity` vs `packages/auth`.**
   Question: when live authentication arrives (Phase 2), which component resolves a
   session/auth-subject to an Operator or Audience User — the future
   `services/identity` module or the existing pure `packages/auth`?
   Why it matters: identity resolution is on every request path of both apps; a
   wrong split creates cycles (identity needs database access; packages must stay
   pure) or duplicates the tenancy spine.
   Recommendation: `packages/auth` stays a pure rules layer (identity kinds,
   verification decision — as today); `services/identity` owns durable identity
   state and exposes `resolveIdentity(sessionRef)`; both apps' BFFs call it
   server-side only.
   **RESOLVED — Decision 3 approved (Phase 2 decision session):** `packages/auth`
   remains a pure rules layer (unchanged); `services/identity` owns durable
   identity state and `resolveIdentity(sessionRef)`; both BFFs resolve identity
   server-side; Supabase Auth is the credential issuer only, never the domain
   identity owner.

10. **Audit trail write path.**
    Question: how do the ~20 audit-relevant transitions per DOMAIN_MODEL §38 reach
    the `audit_log` without violating "no cross-module writes" — direct table
    writes (forbidden), event consumption only, or a narrow append API?
    Why it matters: audit loss is a compliance failure, but a synchronous append
    dependency from every module is the heaviest possible coupling; the tension
    between audit reliability and the ownership rule is real.
    Recommendation: `services/admin-audit` exposes one narrow, append-only API as
    **the single sanctioned cross-module write**; security-critical actions
    (permission changes, gate/QC decisions, takeovers) append synchronously
    before committing; everything else arrives via events once durable transport
    exists.
    **RESOLVED — Decision 4 approved (Phase 2 decision session):**
    `services/admin-audit` exposes `admin-audit.append` as the sole audit write
    path; same-transaction synchronous for security-critical actions (fail-closed
    on append failure); append-only and immutable; records carry actor, target
    aggregate, action, opaque before/after snapshots, and the correlation set;
    reads gated by `audit.read`.

## 28. Architectural Suggestions

Exactly six. **None is implemented by this document.**

1. **SUGGESTION** — What: fold Planning Engine and Project Management as sub-modules
   of `services/production-engine` rather than separate directories.
   Why: they share the production aggregate family (projects, productions, plans,
   gate decisions, manifests) and a premature split would blur a coherent boundary.
   Impact: fewer directories; identical logical boundaries.
   Changes approved architecture: NO.

2. **SUGGESTION** — What: implement Quality Control as its own
   `services/quality-control` module at implementation time.
   Why: QC gates assets, generations, productions, **and** publications — wider
   than the production engine's scope; embedding it would make production-engine a
   dependency of publishing beyond read-only references.
   Impact: one more module.
   Changes approved architecture: NO.

3. **SUGGESTION** — What: introduce an outbox table when event transport goes
   durable (Phase 3, Stage 2).
   Why: the in-process publisher has no transactional guarantee; the outbox is the
   seam that makes worker-era events reliable without changing the
   `EventPublisher` interface.
   Impact: one table plus a publisher implementation swap.
   Changes approved architecture: NO.

4. **SUGGESTION** — What: codify the `public-service` element-class convention
   (naming + ESLint registration steps) for every future Media-facing module or
   fragment.
   Why: keeps Media exposure opt-in, auditable, and review-gated as the platform
   grows; makes the boundary test repeatable.
   Impact: configuration convention + documentation only.
   Changes approved architecture: NO.

5. **SUGGESTION** — What: keep `packages/database` as the sole Drizzle schema owner;
   domain modules depend on it and never define schemas themselves.
   Why: single source of schema truth, matching the implemented foundation; prevents
   schema fragmentation across 20+ modules.
   Impact: none today; a rule to hold at schema implementation time.
   Changes approved architecture: NO.

6. **SUGGESTION** — What: each app gets a **single server-only composition root**
   that constructs modules with their adapters (storage providers, compute
   providers, model adapters, email, event publisher) and hands typed module
   instances to BFF route handlers; modules receive all dependencies via
   constructor/parameter injection and never construct adapters themselves.
   Why: it is the concrete mechanism behind "apps do not access infrastructure
   directly" and "secrets are injected server-side only" — one auditable seam per
   app where credentials exist; and swapping the composition root is exactly what
   turns an in-process module into a remote client at extraction time.
   Impact: one server-only wiring file per app; constructor-injection style in
   modules; no behavior change.
   Changes approved architecture: NO.

## 29. Contradictions Check

Compared against SYSTEM_ARCHITECTURE.md, DOMAIN_MODEL.md, PRODUCT_VISION.md,
PRODUCT_SCOPE.md, PRINCIPLES.md, GLOSSARY.md, ROADMAP.md, existing contracts, and
the existing package/service/application boundaries:

**Contradictions found: none.**

Alignment confirmed: content origin rule (publication-only path to public content —
§18); audience rule (Media reach = public-service only — §13); all 16 PRINCIPLES
(modular-first, gate-first, pluggable models/workflows/compute, publishing
separation, provenance, fail-safety, never-trust-browser, humans retain authority);
ROADMAP phase ordering (Stage mapping matches Phases 0–7); the dependency direction
and Media blocklist match the implemented ESLint configuration exactly (verified
against `eslint.config.mjs`); the ownership matrix covers every DOMAIN_MODEL §38
table family exactly once; event usage is the existing contract only.

**Tensions/ambiguities (reported, not silently resolved):**

1. **In-process event publisher has no transactional guarantee** — a limitation of
   the current foundation, not a contradiction. Resolution path documented (outbox
   seam, SUGGESTION 3; Open Question 4). No code changed.
2. **Audience User appears in two bounded contexts (1 and 12) of DOMAIN_MODEL** —
   a deliberate modeling overlap. Resolved *in this document's ownership
   assignment* (§11): rows owned by identity, referenced by audience. This is an
   ownership decision for review, not a silent change to DOMAIN_MODEL.
3. **`EMAIL_VERIFIED_ACTIONS` tension** — already reported in DOMAIN_MODEL
   (SUGGESTION 6 there): contracts list comment/share while `@stratifit/auth` also
   gates `message`. Still open; still unresolved; still not implemented. This
   document assumes the authoritative `@stratifit/auth` rule (messaging requires
   email verification) in its messaging architecture.
4. **Contexts-to-modules is not 1:1** — explicitly permitted: multiple contexts
   share a module where aggregates are cohesive (production-engine hosts the
   Production context only; planning/PM are sub-capabilities), and one context
   spans two modules where the plan already split it (Public Media & Audience →
   audience + notifications). Every *persisted concept* still has exactly one
   owner, which is the invariant that matters.

## 30. Verification

Plan-approved verification checklist for this specification:

1. SERVICE_ARCHITECTURE.md exists — ✅ (this file).
2. Required header present — ✅ (line 3).
3. Exactly 10 Open Questions — ✅ (§27).
4. Exactly 6 Suggestions, all "Changes approved architecture: NO" — ✅ (§28).
5. All 17 bounded contexts mapped — ✅ (§5).
6. All 31 listed capabilities classified — ✅ (§6).
7. Every domain aggregate has exactly one owner — ✅ (§7; the 24 DOMAIN_MODEL
   aggregates each appear once in the Aggregates column).
8. No dependency cycle — ✅ (§8 cycle check; DAG).
9. Media restrictions match the existing ESLint boundary — ✅ (§13 vs
   `eslint.config.mjs`: compute, ai, workflows, database, storage,
   production-engine blocked; public-service allowlist preserved).
10. No vendor leakage into domain modules — ✅ (RunPod/ComfyUI/FFmpeg/Supabase
    appear only in adapter/worker/provider rows).
11. No premature microservices — ✅ (zero new deployables at Stage 1; extraction
    gated by criteria).
12. No code/schema/migration changes — ✅ (documentation only; regression check
    below).

Regression command (documentation-only change): run
`pnpm exec turbo run typecheck lint test build` and confirm green. Do **not**
modify code to make it pass.

> **Stage 2.20 service note:** the Creative / Story foundation
> (`services/creative`, bounded context 3 per DOMAIN_MODEL §8) is IMPLEMENTED
> as a Control-only ports-and-adapters module — the seven-level narrative
> hierarchy (universes → worlds → stories → seasons → episodes → scenes →
> shots), frozen D2.20-6 lifecycle state machines, in-transaction parent-
> chain integrity (same-org, non-retired parents; People precedent), the
> dedicated `creative.manage`/`creative.read` capability family (D2.20-5),
> fourteen same-transaction audit actions (D2.20-8), and NO events (D2.20-4).
> Media has NO surface on this context; scripts and the world-building
> catalog remain deferred (D2.20-2/D2.20-3); `campaign_creative` publishing
> mediation remains fail-closed.

## 31. Deferred Implementation

Explicitly deferred — none of it performed or authorized by this document:

- Relational domain schema, migrations, and any Drizzle change (await DOMAIN_MODEL
  approval; ownership in §11 is conceptual).
- Supabase wiring; authentication implementation; authorization infrastructure
  (Open Question 9 covers the identity-resolution split).
- All 19 future domain modules (identity, creative, people, rights, assets,
  generation, jobs, quality-control, media-processing, messaging, audience, social,
  notifications, search, recommendations, analytics, advertising, live,
  admin-audit) and the ai-director orchestration module.
- Durable messaging store; AI Communication Engine; Control Room inbox UI.
- Live production execution; Job Engine implementation; Redis/BullMQ; workers;
  outbox transport.
- RunPod implementation; ComfyUI runtime; FFmpeg / media processing execution.
- External publishing adapters (YouTube, TikTok, Instagram, Facebook).
- Analytics infrastructure; recommendation engine; search indexing; observability.
- Control Room feature modules (CMS, editorial, advertising operations, live
  production, experimentation tooling).

## 32. Recommended Next Task

**Recommended Next Task: DATA_FLOW.md** — end-to-end data flows across the module
boundaries defined here (planning→gate→manifest→jobs→generation→assets→QC→
publication→public content; messaging→leads; analytics intake), per ROADMAP
Phase 1.

**DATA_FLOW.md has NOT been started automatically.** Neither have
EVENT_ARCHITECTURE.md or API_ARCHITECTURE.md.
