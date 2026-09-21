# Domain Model

> **Bootstrap draft derived from approved foundation and operator architecture brief — pending human review**

**Document Status.** This document is an **architectural specification** — the canonical
domain model for the Stratifit Platform. It is a bootstrap draft pending human review.
**Implementation and database schema work must wait for human review and approval** of
this document. No domain tables exist today: `packages/database` contains only the
foundational `platform_config` table, and nothing in this task changes that.

## 2. Purpose

This specification defines the canonical entities, aggregates, relationships, ownership,
lifecycle, identifiers, boundaries, references, provenance, versioning, permissions,
public/private visibility, cross-domain references, and invariants for the entire
Stratifit Platform — covering both **Stratifit Control** (internal production/control
operating system) and **Stratifit Media** (public audience platform), which remain
separate trust boundaries in one monorepo.

Two rules govern everything below:

1. **Content origin rule** — everything public on Stratifit Media originates from the
   internal ecosystem: Internal creation → Planning → Production → QC → Approval →
   Publication → Stratifit Media.
2. **Audience rule** — public users are audience users, not producers. They hold no
   production capability.

## 3. Domain Modeling Principles

1. **Modular-first, no premature distribution.** The model supports future service
   extraction without requiring microservices, event sourcing, CQRS, or distributed
   transactions. Bounded contexts are domain boundaries, not deployables.
2. **Contracts define the spine.** `@stratifit/contracts` (branded IDs, manifest,
   event envelope, audience rules), `@stratifit/auth` (identity kinds, authorization
   decision), `@stratifit/permissions` (operator capability matrix), `@stratifit/ai`
   (ModelAdapter/Registry/Router), `@stratifit/workflows`, `@stratifit/compute`
   (ComputeProvider), the production gate, and the publishing read API are already
   implemented and verified; this model aligns with them rather than replacing them.
3. **Never trust the browser.** All authorization is server-side; identity is resolved
   from server session state, never client claims.
4. **Events communicate; state owns.** Domain events are idempotent notifications of
   committed state transitions; they never replace transactional domain state.
5. **Metadata in PostgreSQL, binaries in object storage.** Large media never lives in
   the database; the database stores references and metadata.
6. **Provenance is immutable.** Historical generations, model/workflow versions, and
   usage records are never silently overwritten.
7. **No vendor leakage.** RunPod is a compute provider behind `ComputeProvider`;
   ComfyUI is a workflow runtime behind `WorkflowRuntime`. Neither name is a domain
   concept; domain records carry provider/runtime *references*, not vendor logic.
8. **Conservative aggregates.** No giant Production aggregate, no giant User aggregate,
   no circular aggregate dependencies; cross-aggregate rules are enforced by domain
   services (e.g., the gate), not by aggregate nesting.

## 4. Bounded Contexts

Seventeen bounded contexts. These are **domain boundaries, not microservices**.

| # | Context | Responsibility | Owned concepts | Upstream / downstream | Exposure |
|---|---|---|---|---|---|
| 1 | **Identity & Tenancy** | Own the tenancy and identity spine | Organization, Team, Operator, Audience User, Membership, Roles, Verification requirements | Upstream of all contexts; downstream of auth provider (external) | Internal + public-safe (audience identity) |
| 2 | **Production** | Plan, gate, and manifest productions | Project, Production, Template, Plan (+ versions), Gate Decision Record, Manifest | Upstream: Identity, Creative, People, Rights. Downstream: Generation, Job, QC, Publishing | Internal only |
| 3 | **Creative / Story** | Own narrative structure | Universe, World, Story, Season, Episode, Scene, Shot, Script, narrative catalog | Upstream: Identity. Downstream: Production, Generation | Internal only |
| 4 | **People (Digital Humans)** | Own synthetic people and creator operations | Digital Human, Character (castable), Persona, AI Creator, Public Profile, Voice (+ versions), Wardrobe (+ states) | Upstream: Identity, Rights. Downstream: Production, Publishing, Messaging | Internal + public-safe (Public Profile) |
| 5 | **Rights & Consent** | Own authorization to use likenesses/voices/content | Rights Owner, Rights Grant (scope/platforms/territories/validity/revocation/audit) | Upstream: People, Identity. Downstream: Production gate, Publishing | Internal only |
| 6 | **Asset Domain** | Own managed media metadata and lineage | Asset, Asset Version, Storage references, Lineage DAG | Upstream: Generation. Downstream: QC, Publishing, Public Media | Internal + public-safe (published versions) |
| 7 | **Generation** | Own AI executions and their provenance | Generation (+ lineage), provenance record | Upstream: Production (manifest), Catalog, Job. Downstream: Asset, QC | Internal only |
| 8 | **Catalog (Model/Workflow)** | Own versioned AI registries | Model (+ versions), Workflow (+ versions), capability/compatibility metadata | Upstream: Identity (org). Downstream: Production planning, Generation | Internal only |
| 9 | **Job / Compute** | Own executable work and compute accounting | Job, Job Dependency, Job Attempt, Compute Requirement, Compute Usage | Upstream: Production, Publishing, Messaging. Downstream: workers (external, referenced only) | Internal only |
| 10 | **QC** | Own quality decisions | QC Check, QC Result, QC Issue, Review/Approval/Rejection | Upstream: Asset, Generation, Production. Downstream: Publishing | Internal only |
| 11 | **Publishing** | Own distribution of approved content | Publication (+ versions), Platform Target, Published Content, Distribution Reference | Upstream: QC, Asset, People. Downstream: Public Media, external platforms (adapters) | Internal only (publishes *public-safe* representations) |
| 12 | **Public Media & Audience** | Own the audience-facing platform domain | Public Content, Audience User, Profile, Viewing, Watch Progress, Notification | Upstream: Publishing. Downstream: Social graph, Analytics, Experimentation | Public-safe |
| 13 | **Social Graph** | Own audience relationships | Follow, Like, Comment, Share, Save | Upstream: Audience, Public Media. Downstream: Notifications, Analytics | Public-safe |
| 14 | **Messaging & Leads** | Own viewer↔creator communication and business inquiries | Conversation, Message, Service Inquiry, Lead, Assignment, Follow-up | Upstream: Audience, Public Profile. Downstream: Control Room inbox, Analytics | Internal inbox; public-safe conversation surface |
| 15 | **Advertising** | Own brands, campaigns, creatives | Brand, Product/Object, Campaign (+ brief, budget, target), Creative (+ variants), Campaign Asset | Upstream: Identity, Production. Downstream: Publishing, Analytics | Internal only |
| 16 | **Analytics** | Own metric references and engagement intake | Metric references over content/campaign/conversation IDs | Downstream-most; consumes IDs from all contexts | Internal (aggregates public-safe events) |
| 17 | **Admin & Audit** | Own permission grants and the audit trail | Permission grants, Audit log | Cross-cutting; observes all contexts | Internal only |

Contexts communicate by **ID references** and **events** — never by importing another
context's internals. The lint-enforced code boundary (Stratifit Media may not import
internal production infrastructure) is the mechanical mirror of contexts 11–13's
isolation from contexts 2–10.

## 5. Core Domain Map

```
Identity/Tenancy ─┬─ Projects ─ Productions ─┬─ Plan → Gate → Manifest
                  │                          ├─ Scenes → Shots
                  │                          ├─ Generations → Assets
                  │                          ├─ Jobs → Compute usage
                  │                          ├─ QC
                  │                          └─ Publications ─┐
People ─┬─ Digital Humans ─ Characters ─ Personas ─ Creators          │
        ├─ Voices, Wardrobes                                         │
        └─ Rights grants ────────────────────────────────────────────┤
Models ─ versions ─ capabilities ─────────────────────────────────────┤
Workflows ─ versions ─────────────────────────────────────────────────┤
QC ───────────────────────────────────────────────────────────────────┤
                                                                      ▼
Audience ─ Social graph ─ Notifications ◄──── Public Content ◄─── Publication
Messaging ─ Conversations ─ Messages ─ Leads
Advertising ─ Campaigns ─ Creatives
Analytics ◄── references to all of the above
```

## 6. Identity & Tenancy

### Organization
The top-level tenancy unit; owns all internal production data.

- Internal ID (opaque, stable). Fields: name, slug (unique), status (`active`,
  `suspended`), timestamps. A single default organization exists at bootstrap;
  multi-organization is supported by design, not required by flows.
- Owns: projects, catalogs (model/workflow registries are org-scoped), operators,
  AI creators, campaigns.

### Team
Optional grouping of operators inside an organization; memberships are many-to-many.
Teams simplify assignment (leads, productions) without adding a second tenancy level.

### Operator (internal user)
An authorized internal user of Stratifit Control.

- Distinct entity from audience users. **Internal and public identities must never be
  conflated** (invariant 12).
- Fields: internal ID, organization ref, **auth subject ref** (opaque external identity
  provider subject — authentication internals are deliberately not modeled), display
  name, email, status.
- **Roles**: `admin`, `operator`, `reviewer`, `viewer` — matching
  `packages/permissions`. **Permissions** derive from roles via the existing capability
  matrix (`production.plan`, `production.approve`, `production.publish`,
  `generation.request`, `model.manage`, `workflow.manage`, `compute.allocate`,
  `messaging.takeover`, `lead.assign`, `admin.permissions`, `audit.read`).

### Audience User
A public user of Stratifit Media. Audience, not producer (invariant 16).

- Fields: internal ID, auth subject ref, display handle, email (for verified actions),
  email-verified flag (server-derived, never a client claim), status, timestamps.
- **Anonymous audience behavior**: watching requires no user record at all — anonymous
  viewing produces viewing events keyed by a session/device reference, not a user row.
  A user row is created only on signup.

### Membership
(Subject, organization/team, role, granted-by, granted-at, revoked-at). Audit-relevant;
grants are append-and-revoke, never silently edited.

### Verification requirements
Requirements are **data, not code forks**: `verification_requirements`
(action → required verifications), seeded with comment/share/message → email, so
additional verification requirements can be introduced later without redesigning the
social system. Enforcement stays server-side via the existing pure rule in
`@stratifit/auth`.

## 7. Projects & Productions

### Project
A container for one or more productions inside an organization (a franchise, a client
engagement, a season batch). Fields: internal ID, organization ref, name, slug,
description, status, timestamps.

### Production
The central production unit: a planned, gated, executed, QC'd, publishable work.

- Fields: internal ID, organization + project refs, title, `ProductionKind`
  (film | series | episode | short | comedy | skit | music | documentary | live |
  trailer | advertisement), template ref (nullable), current plan version ref, current
  manifest ref, lifecycle state, timestamps.
- **Production outputs** — scenes/shots (creative), generations, assets, QC records,
  publications — reference the production by ID and are owned by their own contexts
  (Asset, Generation, QC, Publishing), never embedded in the production aggregate.

### Production Template
A reusable, versioned, parameterized blueprint (kind, default structure, default
model/workflow selection policy, gate requirements). Instantiating copies structure
into a production; templates are versioned content.

### Production Plan and Plan Version
The structured plan: scenes/shots outline, asset requirements, model & workflow
selections (each referencing a model/workflow **version**), compute estimate, budget,
rights checklist, safety/moderation requirements. Schema-validated; the plan payload
belongs to planning and is opaque to other contexts. **Any material change creates a
new immutable Plan Version**; the production points at the current one; approved
versions are frozen.

### Production Gate
A **process**, not a persisted entity: evaluation of a plan/manifest draft against
gate rules (validity, structure, rights, model/workflow compatibility, compute
requirements, budget, safety, required approvals) — implemented today as the pure
`evaluateProductionGate`. The persisted artifact is the **Gate Decision Record**
(immutable): production ref, plan version evaluated, inputs snapshot (budget,
moderation-planned), issues, decision, evaluated-by, evaluated-at.

### Production Manifest
The approved executable contract (already specified in `@stratifit/contracts`):
org/production refs, approved-by, scene/shot counts, model selections (capability +
model ID + **model version**), workflow selections (workflow ID + **workflow
version**), compute estimate, rights confirmation booleans, safety, opaque plan
payload. Created only after gate pass + required approvals; immutable once approved.

## 8. Creative / Story Domain

Hierarchy supporting deep structures **without requiring them** (invariant 13: no
level is mandatory unless the domain requires it):

```
Universe → World → Story → Season → Episode → Scene → Shot
```

- **Universe**: top creative container (a shared IP space). Fields: internal ID, org
  ref, name, slug, description, timeline/rules references.
- **World**: a distinct setting inside a universe. A universe has ≥1 worlds; a world
  belongs to exactly one universe.
- **Story**: a narrative (film script, series arc, short, campaign narrative).
  Fields: internal ID, org, universe/world refs (optional), title, logline, kind,
  status (draft/active/completed/retired), version.
- **Season**: groups episodes of a series; episode ordering is explicit.
- **Episode**: an episode of a season; linked to the production that realizes it.
- **Scene**: a dramatic beat inside a story/episode/production. Fields: internal ID,
  production ref (nullable until attached), story/episode ref, order index, title,
  synopsis, status.
- **Shot**: the atomic plannable/generatable unit. Fields: internal ID, scene ref,
  order, description, technical requirements (aspect, duration, fps), status.
- **Script**: versioned textual artifact attached to a story/production (script
  version, format, content reference — storage vs. database text is Open Question 8).
- **Narrative entities** — story-level cast and set dressing of a narrative:
  **Characters** (narrative sense — see People for the digital-human hierarchy),
  **Locations**, **Props**, **Organizations** (fictional), **Vehicles**. Each:
  internal ID, world/universe ref, name, description, attributes (jsonb), visual refs
  (asset refs for look).

## 9. World Building

World building is the part of the Creative domain covering **universes, worlds, their
rules and timelines, and the entity catalogs**:

- **World Rules**: facts/laws of a world (magic systems, technology, physics, canon
  constraints) — versioned text/knowledge entries referenced by stories.
- **Timeline**: ordered significant events of a world/universe (canon chronology);
  entries are referenceable from stories/episodes; ordering is explicit, never derived
  from timestamps.
- **Catalogs**: locations, props, fictional organizations, vehicles, and characters'
  visual looks — org-scoped, versioned when materially changed, referenceable from
  stories, scenes, shots, and productions.

## 10. People / Digital Humans / Characters / Personas / Creators

The conceptual hierarchy is:

```
Digital Human → Character → Persona → AI Creator → Public Profile → Content → Audience
```

**These are FIVE DISTINCT entities. None automatically implies the next.** This is the
model's most important distinction (invariant 11):

- **Digital Human** — the underlying synthetic person (appearance, identity core).
  Fields: internal ID, org ref, name, appearance refs (asset refs), base
  model/workflow refs (versions), status (`draft`, `active`, `retired`). A digital
  human is not automatically a character, persona, or public creator.
- **Character** — a role/identity a digital human (or a castable person) portrays.
  Two senses, one entity: (a) *narrative character* — cast member of a story/world
  (Creative domain); (b) *castable character* — a portrayal a digital human can take.
  Fields: internal ID, org ref, world ref, digital-human ref (nullable — characters
  can exist uncast), name, bio, visual refs, status. A character is not automatically
  a public creator.
- **Persona** — the personality/behavior layer above a character (voice, tone,
  interests, capabilities, languages). Fields: internal ID, character ref, name,
  personality descriptor, interests, capabilities, languages, behavior config ref,
  status. A persona is not automatically a public creator.
- **AI Creator** — the operational entertainer entity the Control Room operates: the
  persona packaged with production capability, shows, services, and communication
  config. Fields: internal ID, org ref, persona ref, handle (unique), display name,
  capabilities, content categories, communication config ref, status (`draft`,
  `active`, `paused`, `retired`), is-AI disclosure flag (always true today). An AI
  creator may exist without any public profile.
- **Public Profile** — the **publication-facing identity** of an AI creator, created
  only through publication (see Publishing). Fields: internal ID, AI-creator ref,
  published handle/name/bio/personality/interests **snapshot**, avatar/poster asset
  refs, messaging-enabled flag (only if the AI creator's communication config
  allows), status (`active`, `paused`, `unpublished`). Profiles are **snapshots**:
  editing the internal AI creator does not mutate the public profile; republishing
  creates a new profile version.

**Chain-integrity rule**: a Public Profile must trace an intact chain
AI Creator → Persona → Character → Digital Human (any link may be a single row; the
chain must exist and be unbroken).

### Voice
A voice associated with a digital human or persona; **Voice Versions are first-class**
(voice cloning evolves; provenance requires the exact version). Fields: internal ID,
owner ref (digital human or persona), version, provider-agnostic descriptor (no vendor
names), sample asset refs, rights ref, status.

### Wardrobe
Costume/look configurations for characters/digital humans. Fields: internal ID, owner
ref, name, description, visual refs (asset refs), status — with **Wardrobe
State/Version** records (costumes change per scene/era); scenes/shots reference a
wardrobe *state*, never a mutable wardrobe row.

## 11. Rights and Consent

Explicit, first-class, and blocking: generation/publication must be blockable when
required rights are invalid (invariant 2). The rights *engine* is future work; the
*model* is here.

> **Stage 2.21 implementation status:** the model is DURABLE —
> `services/rights` owns `rights_owners` / `rights_grants` /
> `rights_status_events` (immutable history-of-record; no `rights.*` bus
> events). V1 subject kinds are `digital_human|character|persona|asset|
> production` (`voice` EXCLUDED pending Open Question 1). Grant CORE fields are
> immutable through the service API (status transitions only, no deletes);
> lifecycle is `draft → active → suspended ⇄ active → revoked/expired` with
> revoked/expired terminal; validity windows are evaluated LAZILY at use time
> by the exported fail-closed `evaluateUse` seam. Ports remain UNWIRED
> (D2.21-2): the production gate, publishing approval, People authoring, and QC
> still treat absent rights as a vacuous pass until a future cutover stage.
>
> **Stage 2.22 requirements declarations:** `rights_requirements` records WHAT
> a subject requires (scope/platforms/territories, `enforce` | `record_only`;
> UNIQUE(org, subject, scope)). Absence of a declaration = `declared: false` —
> the vacuous-pass semantics are preserved EXACTLY (D2.22-2). `enforce` rows
> are immutable after creation (retire by delete + re-create, D2.22-3). The
> port adapters and the pure subject/platform mapping functions are BUILT and
> EXPORTED but NOT injected into any composition (D2.22-4/-5) — the cutover
> that converts vacuous passes into blocking gates remains Stage 2.23.
>
> **Stage 2.23 Publishing cutover (D2.23-1..-5):** the Publication Rights
> adapter is now INJECTED into the Publishing composition as `resolveRights`.
> ONLY **approve** and **retry** (retry re-runs the approval gate by D2.12-E)
> are Rights-gated — `createPublication`/`submit`/`schedule`/`publish`/
> `unpublish`/`revise` are unchanged, and the Publishing state machine is
> unchanged. Gating uses ONLY `enforce` requirements (D2.23-2):
> `record_only` rows observe but never block; zero applicable `enforce`
> declarations keep the vacuous pass (`declared: false`). Frozen evaluation
> inputs: scope `publication`, platform `stratifit_media`, territory
> `worldwide`, at gate-evaluation time (D2.23-3). Subject mapping is the
> frozen Stage 2.22 table — `asset_version` maps to Rights `asset` with the
> asset-version reference as the frozen convention (D2.23-4);
> `ai_creator_profile`/`campaign_creative` remain vacuous (D2.23-5).
> **People cutover is deferred to Stage 2.24** (enforcement point, People
> scope mapping, and `"new"` pre-creation declarations remain open); QC
> rights checks and Production `ManifestRights` remain untouched.

### Rights Owner
A person or entity that can grant usage rights (an individual, a likeness owner, a
licensor). Fields: internal ID, kind (individual | organization), display name,
contact ref, verification status.

### Rights Grant (immutable core, mutable status)
- Internal ID, owner ref, subject ref + subject kind (digital human | voice |
  character | persona | asset | production), **scope** — usage categories
  (generation | publication | advertising | messaging | derivative-creation),
  **platforms** (stratifit-media | youtube | tiktok | instagram | facebook | all),
  **territories** (list or `worldwide`), **validity window** (starts/expires),
  status (`draft`, `active`, `expired`, `revoked`, `suspended`), granted-by/granted-at,
  evidence refs (signed documents → storage refs), approval record.
- **Expiration**: validity windows are evaluated at use time; expired grants never
  silently renew. **Revocation** creates a status change + immutable revocation
  record; grants are never deleted. **Audit history** of all status changes is
  retained (`rights_status_events`).
- **Blocking evaluation semantics** (for the future engine): a required right is
  satisfied only by an active, non-expired, non-revoked grant whose
  scope/platform/territory covers the intended use within the validity window. Any
  gap blocks generation and/or publication — fail closed.

## 12. Assets and Lineage

### Asset
A managed media item. The database stores metadata + storage references; **binaries
live in object storage** (invariant).

- Fields: internal ID, org ref, `AssetKind` (video | audio | image | document |
  subtitle | data), subtype (master | derivative | thumbnail | poster | trailer |
  clip | sample | subtitle | lyrics | caption | document), title, description, current
  version ref, approval state, **visibility** (`internal`, `public`), production/shot
  refs (nullable), tags, timestamps.
- **Asset Version** (immutable): internal ID, asset ref, version number,
  **storage reference** (bucket + key), **checksum**, byte size, mime type, technical
  metadata (resolution, fps, duration, codec, sample rate), created-by, created-at,
  provenance generation ref (nullable — for generated assets).
- **Asset lineage DAG**: `AssetVersion → derived AssetVersion` with a derivation kind
  (generation | edit | transcode | thumbnail | trailer | upscale | enhancement).
  Lineage edges are immutable; a parent asset version is never rewritten; cycles are
  rejected.
- **Approval state**: `pending`, `in_review`, `approved`, `rejected` — see QC.
- Publication references *asset versions*; public visibility is granted at
  publication, not by flipping a flag on the asset.

## 13. Generations and Provenance

### Generation
A single AI model execution producing an output. Full provenance is part of the
record:

| Provenance field | Notes |
|---|---|
| Generation ID | internal ID of this execution |
| Production / Scene / Shot | nullable where not shot-bound |
| Parent generation | lineage (img2img, refinement chains) |
| Input assets | asset-version references (references) |
| Model + model version | must resolve to registry versions |
| Workflow + workflow version | must resolve to registry versions |
| Prompt / negative prompt | negative where applicable |
| Seed | exact reproduction input |
| Parameters | jsonb, schema-validated |
| Resolution / FPS / duration | requested technical spec |
| Adapters / LoRAs | referenced where applicable (weights by version) |
| Runtime version | workflow-runtime + adapter versions |
| Worker / GPU reference | platform-agnostic worker identity + GPU class; never credentials |
| Timestamps | requested / started / completed |
| Estimated cost / actual cost / runtime | estimate vs. actual kept separate |

- Status: `requested`, `running`, `completed`, `failed`, `cancelled`. Output asset
  version ref on success.
- **Historical provenance is immutable** (invariant 3): fields are written at
  completion and never edited; corrections are superseding records, never updates.
  Generation lineage forms DAGs via parent references; parents are never mutated.

### Provenance chain (canonical)

```
Production → Scene → Shot → Generation → Asset → Derived Asset → Published Content
```

with the versioned spine underneath:

```
Production → Plan version → Manifest version → Job → Job attempt
           → Generation (model+version, workflow+version, prompt, seed,
             parameters, runtime, worker, estimated+actual cost)
           → AssetVersion → (derived AssetVersions)*
           → QC → Publication version → Public Content → audience events
```

Every hop is traceable by ID; historical versions remain addressable; a model or
workflow upgrade never destroys the reproducibility of historical productions.

## 14. Models and AI Capabilities

- **Model**: internal ID, org ref, name, **capability** kind(s) (image.generation,
  video.generation, voice.synthesis, music.generation, audio, lip.sync, sfx, vfx,
  enhancement — matching `packages/contracts`), display name, **registry status**
  (`active`, `deprecated`, `disabled`).
- **Model Version** (immutable): internal ID, model ref, version string,
  **adapter reference** (identifier of the registered adapter implementation —
  platform-agnostic; the adapter layer lives in `packages/ai`), **compatibility**
  metadata (input kinds, output kinds, constraints like max resolution/duration),
  default parameters, status, registered-at.
- Compatibility is metadata evaluated by the gate/planner — never vendor logic in the
  domain. Deprecated/disabled versions are not selected for *new* plans but remain
  valid references in historical manifests/provenance.
- **No vendor-specific model domain concepts**: provider details live in adapter
  configuration, not model entities. RunPod is not a domain concept (invariant 20).

## 15. Workflows

- **Workflow**: internal ID, org ref, name, capability kinds, status.
- **Workflow Version** (immutable): internal ID, workflow ref, version, **runtime
  reference** (platform-agnostic runtime-type identifier — ComfyUI is one such runtime
  *type* behind the abstraction, not a domain concept), opaque definition reference
  (payload stored by reference; content owned by the runtime), **compatibility**
  metadata, status, registered-at.
- Workflow implementation must remain replaceable (invariant); historical workflow
  versions are never deleted or rewritten.

## 16. Jobs and Compute

### Job
A unit of executable work (a generation execution, a media-processing pass, a
publication delivery, a notification, a QC run).

- Fields: internal ID, org ref, job type (generation.execute | media.process |
  publication.deliver | notification.send | qc.run), **idempotency key** (unique per
  type+target; retries dedupe on it), subject ref, manifest ref (nullable),
  compute requirement ref (nullable), **execution state**, priority, max attempts,
  attempt count, **progress** (0–100), **errors** (last error + history ref),
  timestamps, cancellation-requested flag.
- **Job Dependency**: DAG edges (job B starts after job A reaches a terminal state);
  cycles rejected.
- **Job Attempt** (immutable): internal ID, job ref, attempt number, **worker
  reference** (platform-agnostic worker identity — worker credentials are never
  stored), allocation ref, started/completed timestamps, outcome (`succeeded`,
  `failed`, `timed_out`, `cancelled`), error detail, progress snapshots (resume
  support where the job type supports checkpoints), usage record ref.
- **Retry / cancellation / idempotency**: retries re-queue with the same idempotency
  key (invariant 7); cancellation is requested, then observed at safe points;
  attempts are recorded immutably.
- **Compute Requirement**: pure estimate structure (matches
  `ComputeAllocationRequest` in `packages/compute`): GPU class, VRAM, workers,
  concurrency, estimated runtime, storage, estimated cost. **Usage**: `ComputeUsage`
  records actuals (allocation ref, actual runtime, actual cost, recorded-at) so
  estimates improve against actuals over time.
- **RunPod is an infrastructure/provider reference, not a domain aggregate**: the
  domain stores `provider` as a reference string on allocations/usage; a domain row
  never contains provider credentials (invariant 4).

<!-- CONTINUED -->
## 17. Media

**A typed Asset + AssetVersion taxonomy covers media — no standalone entity per media
type.** The kinds/subtypes enumerated in the Asset domain are taxonomy, not separate
tables:

- **image**, **video**, **audio** — `AssetKind` values.
- **music**, **SFX**, **VFX** — assets whose provenance points at the generating
  generation (capability-driven outputs).
- **subtitle** — asset kind + subtype (also captions/lyrics).
- **thumbnail**, **poster**, **trailer** — subtypes, typically derivatives of a
  master.
- **master** — an asset version that is the root of its lineage (no parent of
  derivation kind `generation|edit` from another asset).
- **derivative** — an asset version whose lineage edge references its source asset
  version (derivation kind: edit | transcode | thumbnail | trailer | upscale |
  enhancement).

Renders are asset versions with a derivation kind. Publication references asset
versions (typically master + derivatives). This avoids unnecessary standalone
entities while preserving every media type the architecture requires.

## 18. Quality Control

- **QC Check** (definition): internal ID, org, applies-to kind (asset version |
  generation | production | publication), check type (technical | moderation |
  rights | editorial), parameters, required flag, status.
- **QC Result** (immutable): internal ID, subject ref + kind, check ref, outcome
  (`pass`, `fail`, `warn`, `skipped`), details, evaluated-by (human or automated rule
  ref), evaluated-at.
- **QC Issue**: internal ID, result ref, severity (`blocker`, `major`, `minor`,
  `note`), description, resolution state (`open`, `resolved`, `waived`), resolved-by.
- **Review / Approval / Rejection**: per-subject QC Review state
  (`pending → in_review → approved | rejected | changes_requested`) with reviewer
  identity and timestamps; the decision record is immutable and linkable to the
  operator identity and capability check (e.g. `production.approve`).
- **Publication gating**: QC applies at generation output → asset version approval →
  production gate (plan/manifest) → pre-publication. A publication can only proceed
  from a subject whose QC review state is `approved` (invariant 1).

## 19. Publishing

Deliberately **separate from production** (invariant); production's authority ends at
approval; publishing owns distribution.

- **Publication**: internal ID (PublicationId), org ref, **Publication Version**
  (immutable snapshots; a correction is a new version, never an overwrite), **Platform
  Target** (stratifit-media | youtube | tiktok | instagram | facebook), subject ref +
  kind (production | asset version | AI creator profile | campaign creative), content
  payload snapshot (title, synopsis — publishable fields only), QC approval ref,
  scheduled-for, status, timestamps.
- **Published Content** (public representation): internal ID, publication version ref,
  target, public ID/slug, published-at, availability (publish/unpublish windows, geo
  restrictions ref), current public metadata snapshot.
- **Distribution Reference** (immutable): internal ID, publication version ref,
  **external target reference** (opaque external ID on the platform target),
  delivered-at, delivery outcome. For stratifit-media the external ID is the public
  content ID.
- **Publication Status** (state machine below): `draft → pending_approval → approved
  → scheduled → publishing → published | failed`; `failed → pending_approval`
  (re-delivery); `published → unpublished` (takedown).
- **Failure isolation** (invariant 5): a failed publication marks the
  publication/distribution attempt — never the asset or production master.
- Publishing consumes only approved subject references and cannot reach into
  production internals (mirrored in code by the lint boundary).

## 20. Public Media

The audience-facing content hierarchy. **Public content must originate from an
approved publication** (invariant 10): there is **no second, unrelated content
universe**.

- **Content**: internal ID + public slug, publication version ref, content type
  (film | movie | series | episode | short | comedy | skit | music | music-video |
  documentary | live-program | trailer | advertisement), title, synopsis, media refs
  (public asset version refs), duration/technical snapshot, creator profile ref,
  series/episode navigation refs, categories/tags, published-at, availability ref,
  status (`published`, `unpublished`).
- **Film/Movie**, **Short**, **Comedy**, **Skit**, **Music**, **Documentary**,
  **Trailer**, **Advertisement** — content types of a single Content entity.
- **Series** — content whose episodes are content referencing it; episode ordering
  explicit.
- **Episode** — content of type episode with a series navigation ref.
- **Live Program** — content of type live-program with a schedule reference; live
  control itself is internal production (deferred).
- **Creator** / **Public Profile** — public content references the *public profile*
  (publication-facing identity), never the internal AI creator.

## 21. Audience

- **Audience User** — as defined in Identity & Tenancy; created only on signup.
- **Profile** — optional public display profile (display name, avatar ref, bio),
  separated from the auth subject and never conflated with operator identity.
- **Viewing** — analytical watch events (content ref, audience-user-or-anonymous-
  session ref, device class, started-at, duration). **Watching is possible without
  signup** — anonymous sessions, not user rows.
- **Watch Progress** — transactional per (user, content): position seconds, updated
  at; powers "continue watching"; not required for anonymous viewers.
- **Notifications** — internal ID, recipient, kind (comment-reply, follow, message,
  publication-of-followed-creator, system), payload, read-at. A failed notification
  never rolls back a successful message (invariant 6). **Stage 2.18 implemented the
  in-app foundation** (D2.18-SELECT/N1..N5): one audience-private `notifications`
  owner aggregate with kind `conversation_reply` only, written ONLY by the
  `message.created` consumer (recipient resolved server-side from committed
  conversation state), idempotent by `event_id`, unread DERIVED from `read_at IS
  NULL` (no counter column), owner mark-read unaudited. Social-derived kinds stay
  deferred behind D2.15-3 (no `social.*` events); notification preferences and all
  external delivery channels (email/push/SMS/WhatsApp) remain deferred.
- **Likes / Comments / Shares / Saves** — see Social Graph.

## 22. Social Graph

Asymmetric by design; no symmetry assumptions (invariant):

- User → follows → Creator (public profile)
- User → follows → User (where appropriate)
- Creator → follows → Creator
- User → likes → Content (unique per user+content)
- User → comments → Content (threaded via parent comment ref; visibility states)
- User → shares → Content (channel recorded)
- User → saves → Content (bookmarking)

The graph references **public content and public profiles only** — never internal
production entities.

## 23. Messaging

Flow: **Viewer → Creator Profile → Message → Email Verification → Conversation →
AI Communication → Control Room Inbox → Human Takeover.**

- **Conversation**: internal ID (ConversationId), org ref, creator-profile ref,
  audience-user ref, subject (optional), **Conversation Status** (`open`,
  `awaiting_ai`, `active`, `awaiting_human`, `closed`), lead ref (nullable),
  assignment ref (nullable), unread counts, timestamps.
- **Participant**: the conversation's two fixed participants (audience user ↔ public
  profile); operator takeover is recorded as an event + assignment, not a third
  participant row.
- **Message** (immutable): internal ID, conversation ref, **author kind**
  (`ai` | `human` | `system` — matches `MessageAuthorKind` in `@stratifit/contracts`),
  author ref, body, **message type** (message | service-inquiry | system-notice),
  **references/links** (typed list: content refs, service refs, external URLs),
  sent-at, read receipts.
- **Message types MUST distinguish AI-generated, human-generated, and
  system-generated** messages — enforced by author kind (invariant).
- **Human Takeover**: an operator event (who, when) switching authorship to human and
  setting conversation status; recorded and auditable.
- **Service Inquiry**: a message (or derived record) classified as a business
  inquiry — requested-service ref, classification, confidence (if AI-classified),
  status; becomes the seed of a **Lead** (Lead Status tracked there).
- The communication engine itself is **not implemented** — only modeled.

## 24. Leads and Services

- **Service**: an offering a creator/organization provides (internal ID, org ref,
  creator ref, name, description, category, status); referenced by inquiries.
- **Service Inquiry**: derived from a conversation message — classification,
  requested-service ref, status; becomes the seed of a **Lead** (Lead Status tracked
  there).
- **Lead**: internal ID, org ref, **conversation ref**, creator-profile ref,
  audience-user ref, service-inquiry ref, classification, requested-service ref,
  **status** (`new`, `triaged`, `assigned`, `in_progress`, `won`, `lost`,
  `archived`), **assignment** ref (operator), **follow-up** records (immutable:
  who, when, what), timestamps. Transitions are recorded events (audit), never
  silent updates.
- Example flow preserved end-to-end: viewer messages "I want a website like this" →
  conversation → inquiry classification → lead in the Control Room inbox with the AI
  profile, viewer, and transcript visible to operators.

## 25. Advertising and Campaigns

Supports **(1) external business advertising, (2) sponsored entertainment, (3)
Stratifit self-promotion**.

- **Brand**: internal ID, org ref, name, contact, status.
- **Product/Object**: internal ID, brand ref, name, description, asset refs.
- **Campaign**: internal ID, org ref, brand ref, objective, **Campaign Brief**
  (structured), **Audience Target** (definition ref), **Budget** (total + spent
  tracking), schedule, status, **production relationship** (production ref nullable —
  campaign creative may be produced via the normal production pipeline), timestamps.
- **Creative**: internal ID, campaign ref, production/asset refs, kind (spot |
  sponsored-content | self-promo), status. Creative goes public only via publication.
- **Creative Variant**: internal ID, creative ref, variant key, **campaign asset**
  refs — hooks into Experimentation.
- **Distribution**: publication refs generated from campaign creatives.
- **Performance reference**: analytics references keyed by
  publication/campaign/creative IDs (no warehouse here).

## 26. Analytics

**Three clearly separated families** (invariant 15):

1. **Transactional domain state** — owned by aggregates (production status, lead
   status, watch progress, budget counters).
2. **Domain events** — idempotent notifications of committed state transitions
   (production.created, publication.published, …) aligned to `DomainEventName`.
3. **Analytical events** — append-only observations (`analytics.received` intake),
   never written back into domain state.

Metric families and their **domain references** (tagging model, not a warehouse):

| Metric | Domain references |
|---|---|
| Views, watch time, retention, completion | content ref, audience-user-or-session ref, publication ref |
| Likes, comments, shares, followers | content/profile refs + actor refs |
| CTR, conversions | campaign/creative/publication refs |
| Revenue | org/campaign/publication refs |
| Messages, service inquiries | conversation/lead refs |

No analytics infrastructure is built in this task.

## 27. Experimentation

- **Experiment**: internal ID, org, **target** kind (thumbnail | title | description |
  hook | trailer | social-clip | other public content), **content relationship**
  (target content ref), hypothesis, status (`draft`, `running`, `concluded`,
  `archived`), started/ended at.
- **Variant**: internal ID, experiment ref, key, payload (the variant content
  reference).
- **Assignment**: internal ID, experiment ref, variant ref,
  audience-user-or-session ref, assigned-at (sticky per subject).
- **Metric reference**: outcome metrics reference the analytics domain (CTR,
  completion, conversion…). **No experimentation logic is implemented** — entities
  reserved only.

## 28. Identifiers

Three distinct concepts, three distinct fields:

| Kind | Convention | Notes |
|---|---|---|
| **Internal ID** | opaque, stable, prefixed per entity (`org_`, `proj_`, `prod_`, `gen_`, `pub_`, `conv_`, `lead_`…) or UUIDv7; never reused; never sequential-guessable in public contexts | the only key used inside the platform |
| **Public handle/slug** | human-readable, unique per scope (creator handle `@ava-ai`, content slug `night-harbor`, org slug) | separate column from internal ID so internal IDs never leak; public surfaces expose only these |
| **External provider ID** | opaque reference to a target platform's own ID | stored only on Distribution References (and auth subject refs); never on domain aggregates as a key |

Also defined:

- **Version IDs** — version rows have their own internal IDs in addition to the
  (entity, version) pair.
- **Event IDs** — unique per event; the idempotency key for handlers.
- **Correlation IDs** — the platform correlation set carried on every event envelope
  (organization, project, production, job, publication, conversation).
- **Idempotency keys** — job retries dedupe on (job type, subject, key); event
  handlers dedupe on eventId.

## 29. Aggregate Roots

**24 planned aggregate roots**, defined conservatively. Deliberately NOT modeled: a
giant Production aggregate containing the whole production universe; a giant User
aggregate containing all social behavior; circular aggregates; premature distributed
transactions.

| # | Aggregate Root | Responsibility | Owned entities | Key invariants | Cross-aggregate references (by ID) |
|---|---|---|---|---|---|
| 1 | Organization | tenancy root | teams, memberships, role grants | roles derive capabilities; membership audit | operators, projects, creators, brands |
| 2 | Operator | internal identity + roles | role assignments | never conflated with audience | gate decisions, approvals, takeovers, leads |
| 3 | Audience User | public identity + verification | profile, verification state | audience ≠ producer | social graph, conversations, notifications |
| 4 | Project | production grouping | — | belongs to one org | productions |
| 5 | Production | the production lifecycle | plan versions, gate decisions, manifest versions | approval requires gate decision | assets, generations, jobs, QC, publications |
| 6 | Universe | creative container | worlds, rules, timeline entries | world belongs to one universe | stories, catalog entities |
| 7 | Story | narrative | seasons, episodes, scenes, shots | no level mandatory | productions, generations |
| 8 | Digital Human | synthetic person | appearance refs | not automatically cast/portraying | characters, personas |
| 9 | Character | portrayal role | wardrobe state refs | not automatically public | personas, scenes/shots |
| 10 | Persona | personality layer | behavior config | not automatically a creator | AI creators |
| 11 | AI Creator | creator operations | communication config | active before profile publication | public profiles, conversations, leads |
| 12 | RightsGrant | usage authorization | status events, evidence refs | never deleted; fail-closed evaluation | gate checks, publication checks |
| 13 | Asset | media item | version list, lineage edges | binaries never in DB | generations, publications, public content |
| 14 | Generation | one AI execution | provenance record | provenance immutable | assets, QC |
| 15 | Model / Model Version | AI capability registry | compatibility metadata | refs resolve to versions | manifests, generations |
| 16 | Workflow / Workflow Version | workflow registry | definition reference | refs resolve to versions | manifests, generations |
| 17 | Job | executable work | dependencies (in), attempts | idempotent retries | generations, media processing, delivery |
| 18 | QC Review | quality decision | results, issues | decisions immutable | assets, productions, publications |
| 19 | Publication | distribution of approved content | versions, content snapshot, distribution refs | requires approval | public content |
| 20 | Public Content | audience-facing content | availability, metadata snapshot | originates from publication | audience, social graph, analytics |
| 21 | Conversation | viewer↔creator thread | messages, status, assignment | author kinds distinguishable | leads |
| 22 | Lead | business inquiry | follow-up records | transitions recorded | conversations |
| 23 | Brand / Campaign | advertising operations | creatives, variants | creative publishes via publication | publications |
| 24 | Experiment | content experimentation | variants, assignments | sticky assignments | analytics |

Cross-aggregate rules are enforced by domain services (the gate, publishing checks),
not by aggregate nesting or distributed transactions.

## 30. Value Objects

- **IDs** — branded/opaque internal IDs per entity (see Identifiers).
- **Handles & slugs** — public identifiers (creator handle, content slug, org slug).
- **StorageRef** — { bucket, key, checksum, byteSize, mimeType }: coordinates of a
  binary in object storage; never the binary.
- **TechnicalSpec** — { width, height, fps, durationSeconds, codec } (dimensions,
  duration).
- **TimeWindow** — { startsAt?, endsAt? } (rights validity, availability windows).
- **UsageScope** — { categories[], platforms[], territories[] } (platform/territory
  scopes).
- **Money** — { amount, currency } (cost estimates; estimated vs actual separate).
- **Percentage** — progress (0–100), confidence, experiment metrics.
- **CapabilityRef** — capability kind + version (permission/capability references).
- **ResourceRequirement** — GPU class, VRAM, workers, concurrency, storage (compute
  requirements).
- **ProvenanceRef** — { manifestVersion, modelId+version, workflowId+version, seed }
  (provenance references).
- **GateIssue** — { code, message } (already in code).
- **VerificationRequirement** — { action → requirements } (data, not code).

## 31. Entity Relationships

- Organization 1—* Project; Organization 1—* Operator; Organization 1—* Universe;
  Organization 1—* AI Creator; Organization 1—* Brand.
- Project 1—* Production; Production *—1 ProductionTemplate (optional).
- Production 1—* PlanVersion (one current); Production 1—* GateDecisionRecord;
  Production 1—* ManifestVersion (one per approval).
- Universe 1—* World; World 1—* Location/Prop/Organization/Vehicle; Universe/World
  1—* Story; Story 1—* Season; Season 1—* Episode; Story/Episode 1—* Scene;
  Scene 1—* Shot.
- DigitalHuman 1—* Character (castable, optional); Character 1—* Persona; Persona
  1—0..1 AI Creator; AI Creator 1—* PublicProfile (one active per target).
- DigitalHuman/Persona 1—* Voice (versioned); Character/DigitalHuman 1—* Wardrobe
  (versioned states).
- RightsOwner 1—* RightsGrant; RightsGrant *—1 subject (polymorphic ref).
- Asset 1—* AssetVersion; AssetVersion *—1 parent AssetVersion (lineage DAG);
  Generation 1—0..1 output AssetVersion (on success).
- Model 1—* ModelVersion; Workflow 1—* WorkflowVersion.
- Job 1—* JobAttempt; Job *—* Job (dependency DAG); Job *—0..1 ComputeRequirement;
  JobAttempt *—0..1 ComputeUsage.
- QCReview 1—* QCResult; QCResult 1—* QCIssue.
- Publication 1—* PublicationVersion; PublicationVersion 1—0..1 PublishedContent;
  PublicationVersion 1—* DistributionReference.
- PublicContent *—1 CreatorProfile; AudienceUser *—* PublicContent (like, save);
  AudienceUser *—* AudienceUser/CreatorProfile (follow); Comment tree on
  PublicContent.
- Conversation 1—* Message; Conversation 1—0..1 Lead; Lead 1—* FollowUp.
- Brand 1—* Campaign; Campaign 1—* Creative; Creative 1—* Variant; Creative *—*
  Publication.
- Experiment 1—* Variant; Experiment 1—* Assignment.

## 32. Lifecycle State Machines

Explicit states; no invented unnecessary states. Terminal states listed per machine.

1. **Production**: `draft → planning → in_gate → approved → queued →
   in_production → post_production → qc → ready_for_publication → published →
   archived`. Returns: any state → `on_hold` → previous state;
   `qc → changes_requested → in_production`. **Terminal**: `archived`,
   `cancelled`. Approval requires a recorded gate decision (invariant 1).
2. **Job**: `created → queued → running → completed | failed | cancelled`.
   Recovery: `failed → queued` (retry up to max attempts, same idempotency key);
   `running → queued` (resume from checkpoint where supported);
   `cancellation_requested` overlays running/queued. **Terminal**: `completed`,
   `cancelled`, `failed` (attempts exhausted).
3. **Generation**: `requested → running → completed | failed | cancelled`.
   **Terminal**: all of completed/failed/cancelled — a retry is a *new generation*
   whose parent chain preserves lineage; provenance immutable at completion.
4. **Asset (version approval)**: `pending → in_review → approved | rejected`;
   `rejected → pending` (after fixes create a new version). **Terminal**: `approved`
   (a superseding version restarts the cycle).
5. **QC Review**: `pending → in_review → approved | rejected |
   changes_requested`; `changes_requested → pending`. Decision records immutable.
   **Terminal**: `approved`, `rejected` (subject-level).
6. **Publication**: `draft → pending_approval → approved → scheduled → publishing →
   published | failed`. Recovery: `failed → pending_approval` (re-delivery attempt);
   `published → unpublished` (takedown). **Terminal**: `failed` (retries exhausted),
   `unpublished`. Failure never invalidates the master (invariant 5).
7. **Conversation**: `open → awaiting_ai → active → awaiting_human → closed`;
   `awaiting_human → active` (human takeover recorded); `active → awaiting_ai`.
   **Terminal**: `closed` (audit retained).
8. **Message**: no lifecycle — immutable once written (audit).
9. **Lead**: `new → triaged → assigned → in_progress → won | lost | archived`.
   Assignment recorded; transitions are audit events. **Terminal**: `won`, `lost`,
   `archived`.
10. **Campaign**: `draft → active → paused → completed | cancelled`; budget tracked
    alongside. **Terminal**: `completed`, `cancelled`.
11. **AI Creator**: `draft → active ⇄ paused → retired`. Public profile publication
    requires `active` (invariant). **Terminal**: `retired`.
12. **Rights Grant**: `draft → active → expired | revoked | suspended ⇄ active`
    (reinstatement is a new audit event, not a silent flip). Expired/revoked grants
    never silently renew (invariant). **Terminal**: `expired`, `revoked`.

## 33. Versioning

| Concept | Mechanism |
|---|---|
| **Entity Identity** | stable opaque internal ID, never reused |
| **Entity Version** | immutable version rows (plan versions, publication versions, profile snapshots) + **current pointer** on the owning entity |
| **Asset Version** | append-only; current pointer; lineage DAG |
| **Generation** | each execution is its own immutable record; lineage via parent ref |
| **Generation Lineage** | parent → child DAG (img2img/refinement); parents never mutated |
| **Model Version** | immutable registry rows; deprecated ≠ deleted |
| **Workflow Version** | immutable registry rows; never rewritten |
| **Publication Version** | immutable snapshot per correction |

Historical records remain **reproducible**: manifests pin model/workflow versions;
generations pin their exact versions; registry rows are never overwritten
(invariant). Upgrades create new versions; nothing is mutated in place.

## 34. Provenance

Canonical chain (each hop traceable by ID; versions pinned):

```
Organization → Project → Production → PlanVersion → ManifestVersion
  → Job → JobAttempt → Generation (model+version, workflow+version, prompt,
    seed, parameters, adapters/LoRAs, runtime version, worker/GPU ref,
    estimated+actual cost)
  → AssetVersion → (derived AssetVersions)* → QCReview
  → PublicationVersion → PublishedContent → audience/analytics events
```

Generation provenance remains traceable to all required inputs and execution
metadata because the generation record itself carries the full set (see §13):
production/scene/shot refs, parent generation, input asset versions, model and
workflow *versions*, prompt, negative prompt, seed, parameters, requested
resolution/FPS/duration, adapters/LoRAs, runtime version, worker/GPU reference,
timestamps, and estimated vs. actual cost/runtime. Storage references include
checksums so outputs can be verified against their provenance.

**Immutability rules**: generation provenance, gate decisions, QC decisions,
distribution references, and lead transitions are written once. Corrections are
superseding records, never edits (invariant 3).

## 35. Domain Events

Domain events communicate committed state changes; they never replace transactional
domain state (invariant 15). Names align with the existing `DomainEventName` enum in
`@stratifit/contracts`; **the event implementation is not modified and no new naming
convention is created**:

`production.created`, `production.updated`, `production.approved`, `job.created`,
`job.started`, `job.progress`, `job.completed`, `job.failed`, `job.cancelled`,
`generation.created`, `generation.completed`, `generation.failed`, `asset.created`,
`asset.approved`, `publication.created`, `publication.published`,
`publication.failed`, `conversation.created`, `message.created`, `message.read`,
`analytics.received`.

Future extensions (named later, when needed): `asset.rejected`, `qc.approved`,
`qc.rejected`, `rights.granted/revoked/expired`, `publication.unpublished`,
`lead.created/assigned`, `campaign.created`, `creator.published/unpublished`.

Envelope: eventId (idempotency), name, sequence, occurredAt, correlation set,
schema-validated payload — exactly the existing `DomainEventEnvelope`. Handlers are
idempotent by eventId. The existing in-process publisher and envelope contract stand;
no transport is built here.

**Separation** (invariant 15): transactional domain state owns truth; domain events
communicate transitions; analytical events (`analytics.received`) are append-only
observations never written back into domain state.

## 36. Security Boundaries

Trust zones (browser is never trusted; all authorization server-side):

```
Public Browser → Stratifit Media → Public API/BFF
              → Public-safe domain services → Data (DB/Storage/Events)

Internal Operator → Stratifit Control → Authorized internal APIs
                  → Domain services → Production services → Compute Manager
                  → Workers (GPU)
```

- **Media MUST NOT access internal production infrastructure directly** — enforced
  mechanically by the ESLint import boundaries (Media cannot import compute, AI,
  workflows, database, storage, or the production engine).
- **Never placed in public domain objects** (invariant 4): RunPod credentials, GPU
  credentials, provider secrets, worker secrets, storage admin credentials, internal
  service secrets. Domain entities carry only opaque reference strings (provider
  name, storage ref, worker ref, external target ID).
- Identity separation: Operator and Audience identities are distinct entities and
  never conflated (invariant 12); public messaging exposes the public profile, never
  internal identity.
- Audit: memberships, role changes, gate decisions, QC decisions, approvals,
  revocations, takeovers, and lead transitions are audit-relevant and retained.

## 37. Domain Invariants

1. A publication can only publish content that has passed required approval
   (QC review `approved`; production `ready_for_publication`).
2. A generation cannot execute when required rights are invalid (fail closed).
3. Historical provenance cannot be silently overwritten; corrections supersede.
4. Stratifit Media cannot access internal infrastructure credentials; secrets never
   appear in domain entities.
5. A failed publication does not invalidate the production master.
6. A failed notification does not roll back a successful message.
7. Retryable jobs require idempotency (idempotency key per type+target).
8. A model reference must resolve to an explicit model version.
9. A workflow reference must resolve to an explicit workflow version.
10. Public content must originate from an approved publication — no second content
    universe.
11. Digital Human, Character, Persona, AI Creator, and Public Profile remain five
    distinct entities; none automatically implies the next.
12. Internal (operator) and public (audience) identities are not automatically
    equivalent and must never be conflated.
13. No creative hierarchy level is mandatory; deep hierarchies are supported, not
    required.
14. Social relationships are asymmetric unless explicitly modeled otherwise.
15. Events communicate; transactional domain state owns truth; analytical events are
    separate from both.
16. Audience users are never producers; Control capabilities never derive from
    audience identity.
17. Anonymous viewers may watch; verified actions (comment/share/message) require
    server-verified email (requirement data, extensible).
18. Rights grants are never deleted; revocation/expiry is recorded, and expired or
    revoked grants never silently renew.
19. Immutable records: plan/manifest versions, gate decisions, generations, asset
    versions, QC decisions, distribution references, messages, lead transitions,
    audit log.
20. No vendor-specific domain concepts: RunPod and ComfyUI exist only behind
    abstractions, as provider/runtime references.
21. Large media binaries live in object storage, never as database blobs; the
    database stores metadata, references, and checksums.
22. A job dependency graph is acyclic; cycles are rejected.
23. A public profile must trace an intact chain AI Creator → Persona → Character →
    Digital Human.
24. Versioned entities mutate only by appending new versions; the current pointer is
    the only mutable reference.
25. Asset lineage is a DAG; cycles and parent rewrites are rejected.

## 38. Persistence Guidance

**Conceptual ONLY — this is not the final relational schema. No SQL, no migrations,
no Drizzle changes. The final schema follows after DOMAIN_MODEL.md approval.**

**Shared-database naming note (Stage 2.17):** the production Supabase project
also hosts a pre-existing foreign marketing/CRM application schema in the same
`public` schema. Its `leads` and `services` tables are actively used, owned by
the `postgres` role, and are not administerable by any platform role. The
Messaging & Leads bounded context therefore persists its offering and lead
aggregates as `service_offerings` and `service_leads` — a table-naming deviation
from the conceptual names above, authorized in Stage 2.17 to avoid
cross-application collisions. Domain semantics are unchanged. The foreign
schema remains entirely outside the platform grant/RLS surface.

- **Entities likely persisted** (one table each, typically): organizations, teams,
  memberships, operators, audience_users, verification_requirements, projects,
  productions, production_templates, production_plan_versions,
  gate_decision_records, manifest_versions, universes, worlds, world_rules,
  timeline_entries, stories, seasons, episodes, scenes, shots, scripts,
  narrative catalog (locations/props/organizations/vehicles), digital_humans,
  characters, personas, ai_creators, creator_profiles, voices, voice_versions,
  wardrobes, wardrobe_states, rights_owners, rights_grants, rights_status_events,
  assets, asset_versions, asset_lineage, generations, models, model_versions,
  workflows, workflow_versions, jobs, job_dependencies, job_attempts,
  compute_requirements, compute_usage, qc_checks, qc_results, qc_issues,
  publications, publication_versions, distribution_references, public_content,
  follow_graph, likes, comments, shares, saves, notifications, watch_progress,
  conversations, messages, service_inquiries, services, leads, lead_follow_ups,
  brands, products, campaigns, campaign_creatives, campaign_variants, experiments,
  experiment_variants, experiment_assignments, audit_log.
- **Cardinalities**: Organization 1—* most internal entities; Production 1—*
  plan/manifest versions (one current); Asset 1—* versions (one current);
  Publication 1—* versions; Conversation 1—* messages; AudienceUser *—*
  PublicContent (likes/saves); follows many-to-many.
- **Conceptual uniqueness constraints**: unique org slug; unique creator handle;
  unique content slug per target; unique (follower, followee-kind, followee);
  unique (user, content) for like/save; unique (job type, idempotency key);
  unique (job, attempt number); unique (asset, version number); one current plan
  version per production; one active profile per creator per target.
- **Conceptual indexes**: productions (org, status); generations (production, shot,
  status); asset_versions (asset, version); public_content (status, published_at;
  creator_profile; content_type); comments (content, created_at); messages
  (conversation, sent_at); jobs (status, priority); conversations by correlation
  IDs; events by eventId (idempotency lookup).
- **Immutable records**: plan/manifest versions, gate decisions, generations, asset
  versions, QC decisions, distribution references, messages, usage records, lead
  transitions, rights status events, audit log.
- **Current pointers vs. historical records**: owning entities hold `current_*_ref`
  columns (plan, manifest, asset version, publication version); all historical rows
  remain addressable and are never mutated.
- **Audit requirements**: append-only `audit_log` (actor, action, subject kind/id,
  correlation, payload, at) for permission changes, gate/QC/approval decisions,
  rights status changes, takeovers, lead transitions.
- PostgreSQL stores metadata/relationships/state/permissions/provenance/publication
  records/analytics references; object storage stores binaries (invariant 21).

## 39. Relationship Map

```
Organization
 ├── Teams
 ├── Operators (roles, memberships)
 ├── Audience-facing org config
 └── Projects
      └── Productions
           ├── Template (optional)
           ├── Plan versions → Gate decisions → Manifest versions
           ├── World/Story/Script
           │    ├── Seasons → Episodes → Scenes → Shots
           │    └── Narrative catalog (Characters, Locations,
           │         Props, Organizations, Vehicles)
           ├── Digital Humans → Characters → Personas → AI Creators
           │    └── Voices (versions), Wardrobes (states)
           ├── Rights (owners → grants → status events)
           ├── Assets → Asset versions → Lineage
           ├── Generations (provenance: model+version, workflow+version,
           │    prompt, seed, params, runtime, worker, costs)
           ├── Jobs → Attempts → Compute usage
           ├── QC (checks → results → issues → decisions)
           └── Publications (versions → distribution refs)
                 └── Public Content
                      ├── Creator Profile (public identity)
                      ├── Likes / Comments / Shares / Saves / Follows
                      ├── Notifications
                      ├── Watch progress / viewing events
                      ├── Experiments (variants, assignments)
                      └── Analytics references

Audience Users
 ├── Profiles
 ├── Social graph (follows: user→user, user→creator, creator→creator)
 ├── Conversations → Messages (ai | human | system) → Service inquiries
 │    └── Leads → Assignment → Follow-ups
 └── Notifications

Brands → Campaigns → Creatives → Variants → Publications → Analytics
```

## 40. Open Questions

Decisions requiring explicit approval before database implementation. **Decision
still required: YES** for all ten.

1. **Voice/wardrobe ownership placement.** Question: aggregate voices/wardrobes
   under Digital Human, or keep them independent org-scoped entities with
   associations? Why it matters: determines aggregate size and reuse across
   characters. Recommended direction: independent org-scoped entities with owner
   associations (avoids aggregate bloat). Decision still required: YES.
2. **Tenancy strictness.** Question: hard `org_id` scoping on every table, or
   platform-level shared catalogs for models/workflows? Why it matters: affects
   every table and authorization checks. Recommended: org_id everywhere, catalogs
   org-scoped with a reserved `shared` flag.
   **RESOLVED — Decision 1 approved (Phase 2 decision session):** org_id on all
   domain tables (NOT NULL); infrastructure tables (audit, events, analytics
   intake) nullable where a platform-level record is legitimate; model/workflow
   registries org-scoped with a reserved `shared` flag (readable by all orgs,
   owned and mutable only by the owning org); `verification_requirements` and
   `platform_config` platform-level (no org_id); audience users bound to the
   default organization.
3. **Public profile cardinality.** Question: one active profile per AI creator per
   target, or multiple concurrent profiles? Why it matters: affects messaging,
   content attribution, and uniqueness constraints. Recommended: one active per
   creator per target. Decision still required: YES.
4. **Content inheritance model.** Question: how much series metadata do episode
   publications inherit vs. snapshot fully? Why it matters: affects publication
   immutability and correction workflows. Recommended: full snapshot per
   publication version; navigation references separate. Decision still required:
   YES.
5. **Analytics persistence strategy.** Question: append-only event tables in the
   same PostgreSQL vs. a separate analytical store? Why it matters: determines
   scale/ops profile of the analytics family. Recommended: start same-DB
   append-only; extract later. Decision still required: YES.
6. **Campaign/content relationship.** Question: are campaign creatives just
   productions with a campaign link, or a distinct creative entity feeding
   publications? Why it matters: affects attribution and the advertising context.
   Recommended: distinct creative entity; production relationship optional.
   Decision still required: YES.
7. **Unfollow semantics.** Question: hard delete vs. tombstone for unfollows?
   Why it matters: affects audit completeness of the social graph. Recommended:
   tombstone with deleted-at. Decision still required: YES.
8. **Script storage.** Question: scripts as database text vs. storage references?
   Why it matters: binary/text size policy and versioning ergonomics. Recommended:
   storage reference above a size threshold. Decision still required: YES.
   **Stage 2.20 note:** the Creative / Story foundation (D2.20-3) deliberately
   ships NO script tables/columns and NO world-building catalog entities — this
   question remains OPEN and scripts remain deferred until it is resolved.
9. **Series/episode navigation.** Question: explicit series/episode refs on public
   content vs. a generic parent/child content graph? Why it matters: affects
   queries and future content shapes. Recommended: explicit refs; generic graph
   only if needed later. Decision still required: YES.
10. **Narrative catalog modeling.** Question: separate tables per narrative entity
    type (locations, props, organizations, vehicles) vs. one typed catalog table?
    Why it matters: affects validation and lifecycle per type. Recommended:
    separate tables; revisit if it sprawls. Decision still required: YES.

## 41. Architectural Suggestions

All six: **Changes approved architecture: NO**.

1. **SUGGESTION** — What: split `assets` and `asset_versions` (version rows carry
   storage refs; the asset row carries the current pointer). Why: immutability of
   versions + cheap current reads. Impact: two tables instead of one. Changes
   approved architecture: NO.
2. **SUGGESTION** — What: `verification_requirements` as data (a table), not only a
   code enum. Why: the architecture requires introducing additional verification
   requirements later without redesigning the social system; data makes that
   operational. Impact: one small table + the existing pure rule consults it.
   Changes approved architecture: NO.
3. **SUGGESTION** — What: gate decision records + QC decisions as first-class
   immutable records. Why: humans retain critical authority; approvals must be
   auditable and re-traceable to a plan version. Impact: two tables. Changes
   approved architecture: NO.
4. **SUGGESTION** — What: model/workflow registries org-scoped with a reserved
   `shared` flag. Why: the foundation's registries are in-memory today; durable
   versions must be scoped somewhere. Impact: none now. Changes approved
   architecture: NO.
5. **SUGGESTION** — What: a single `audit_log` table (actor, action, subject
   kind/id, correlation, payload, at) rather than per-domain audit tables. Why:
   uniform retention and queries. Impact: one table. Changes approved
   architecture: NO.
6. **SUGGESTION — `EMAIL_VERIFIED_ACTIONS` alignment.** What: add `"message"` to
   `EMAIL_VERIFIED_ACTIONS` in `packages/contracts/src/audience.ts` (plus a test
   update) **after approval — not implemented in this task**. Why: the existing
   architecture requires email verification before **messaging**
   (`@stratifit/auth` gates `message` with email), so the contracts action set
   must remain aligned with the messaging requirement; today the enumeration lists
   only comment/share. Impact: one-line contract change + test. Changes approved
   architecture: NO (it is what the approved architecture already states).

## 42. Contradictions Check

Analysis against PRODUCT_VISION.md, PRODUCT_SCOPE.md, PRINCIPLES.md, GLOSSARY.md,
ROADMAP.md, SYSTEM_ARCHITECTURE.md, existing contracts, and foundation packages:

**Contradictions found: none.**

The model aligns with: the content origin rule (VISION/SCOPE/SYSTEM_ARCHITECTURE);
the audience rule and out-of-scope list (SCOPE); all 16 principles (PRINCIPLES);
glossary definitions (Digital Human → Character → Persona → AI Creator → Public
Profile → Content → Audience; Production Gate; manifest; provenance; publication
record; platform adapter); the roadmap's "domain schema follows DOMAIN_MODEL.md"
gating; the system architecture's abstraction layers and security boundaries; the
contracts (branded IDs, manifest schema pinning model/workflow versions, event
names, `MessageAuthorKind`, audience rules); `@stratifit/auth` (identity kinds,
email-verification rule); `@stratifit/permissions` (role→capability matrix);
`packages/ai`/`workflows`/`compute` (vendor-free abstractions);
`services/production-engine` (pure gate; manifest builder);
`services/publishing-engine` (separate domain; read API; failure isolation); and
the Media/Control lint boundary.

**Tension identified (reported, not hidden, no code changed):**

- `packages/contracts` `EMAIL_VERIFIED_ACTIONS` lists only `comment` and `share`,
  while `@stratifit/auth` — the authoritative identity rule — requires email
  verification for `comment`, `share`, **and `message`**. This is an internal
  inconsistency between two foundation packages, not a contradiction of the
  approved architecture. **Resolution/recommendation**: adopt the authoritative
  identity rule (message requires verification) and align the contracts
  enumeration after approval — captured as SUGGESTION 6. No code changed in this
  task.

## 43. Verification

Plan-mode verification checklist for this specification:

1. Every major domain from the architecture is represented — ✅ (Coverage Matrix).
2. No major entity contradicts existing terminology — ✅ (Contradictions Check).
3. Control and Media remain separated — ✅ (§4, §36; lint boundary mirrored).
4. Production and Publishing remain separated — ✅ (§19; invariant 5).
5. Digital Human / Character / Persona / Creator distinctions intact — ✅ (§10;
   invariant 11).
6. Model and workflow versions represented — ✅ (§14, §15, §33; invariants 8–9).
7. Provenance represented — ✅ (§13, §34; invariant 3).
8. Rights/consent represented — ✅ (§11; invariants 2, 18).
9. Public content originates through publication — ✅ (§20; invariants 9–10, 12 of
   content origin).
10. Social and messaging concepts represented — ✅ (§21–24).
11. Domain state separated from events and analytics — ✅ (§26, §35; invariant 15).
12. No vendor-specific infrastructure leaked into the domain model — ✅ (§14, §15,
    §16; invariant 20).
13. The model does not require premature microservices — ✅ (§3, §4; modular-first).
14. No database implementation was performed — ✅ (spec only; `platform_config`
    untouched; no migrations).

## 44. Coverage Matrix

| Domain | Covered | Primary Entities | Notes |
|---|---|---|---|
| 1. Tenancy/Identity | ✅ | Organization, Team, Operator, Audience User, Membership | verification-as-data; anonymous viewing via sessions |
| 2. Project/Production | ✅ | Project, Production, Template, PlanVersion, Gate, Manifest | gate = process + immutable decision record |
| 3. Production graph | ✅ | Universe→World→Story→Season→Episode→Scene→Shot | conceptual hierarchy; implementation-agnostic |
| 4. Story/Creative | ✅ | Story, Script, Scene, Shot, narrative catalog | no level mandatory |
| 5. World building | ✅ | Universe, World, WorldRules, Timeline, catalogs | versioned canon |
| 6. Digital people | ✅ | DigitalHuman, Character, Persona, AICreator, PublicProfile | five distinct entities; chain integrity |
| 7. Voice/Wardrobe | ✅ | Voice, VoiceVersion, Wardrobe, WardrobeState | versioned; ownership = open question 1 |
| 8. Rights/Consent | ✅ | RightsOwner, RightsGrant, status events | fail-closed blocking semantics |
| 9. Assets | ✅ | Asset, AssetVersion, lineage DAG, StorageRef | checksums; no DB blobs |
| 10. Generations | ✅ | Generation, provenance record, lineage | immutable; full provenance field set |
| 11. Models/AI | ✅ | Model, ModelVersion, capability, adapter ref | vendor-free |
| 12. Workflows | ✅ | Workflow, WorkflowVersion, runtime ref | ComfyUI not a domain concept |
| 13. Compute/Jobs | ✅ | Job, JobDependency, JobAttempt, ComputeRequirement, ComputeUsage | RunPod = provider reference only |
| 14. Media | ✅ | typed Asset/AssetVersion taxonomy | no unnecessary standalone entities |
| 15. Quality Control | ✅ | QCCheck, QCResult, QCIssue, Review | gates publication |
| 16. Publishing | ✅ | Publication, PublicationVersion, PublishedContent, DistributionReference | failure isolation |
| 17. Public media | ✅ | PublicContent (+types), CreatorProfile | originates from publication only |
| 18. Audience | ✅ | AudienceUser, Profile, Viewing, WatchProgress, Notification | watch without signup |
| 19. Social graph | ✅ | Follow, Like, Comment, Share, Save | asymmetric |
| 20. Messaging | ✅ | Conversation, Message (ai/human/system), takeover | verification flow modeled |
| 21. Leads/Services | ✅ | Service, ServiceInquiry, Lead, FollowUp | conversation-linked |
| 22. Advertising | ✅ | Brand, Product, Campaign, Creative, Variant | three advertising modes supported |
| 23. Analytics | ✅ | metric references over content/campaign/conversation IDs | separate from domain events/state |
| 24. Experimentation | ✅ | Experiment, Variant, Assignment | entities only; no logic |
| 25. Aggregates | ✅ | 24 conservative roots | no giant aggregates |
| 26. Identifiers | ✅ | internal ID, public handle/slug, external provider ID | three distinct fields |
| 27. Versioning | ✅ | version rows + current pointers; lineage; registries | reproducible history |
| 28. Provenance | ✅ | canonical chain §34 | immutable |
| 29. Events vs state | ✅ | DomainEventName-aligned names; envelope unchanged | analytics separate |
| 30. Persistence guidance | ✅ | entity list, cardinality, constraints, indexes, audit | conceptual only |

## 45. Deferred Implementation

Explicitly deferred (none of it performed in this task):

- Relational domain schema and migrations.
- Supabase wiring; authentication implementation; authorization infrastructure.
- Durable messaging store; AI Communication Engine; Control Room inbox UI.
- Live production execution; Job Engine implementation; Redis/BullMQ.
- RunPod implementation; ComfyUI runtime; media processing.
- External publishing adapters (YouTube, TikTok, Instagram, Facebook).
- Analytics infrastructure; recommendation engine; observability.
- Control Room feature modules (CMS, editorial, advertising operations, live
  production, experimentation tooling).

## 46. Recommended Next Task

**Recommended Next Task: SERVICE_ARCHITECTURE.md** — service boundaries, ownership of
each bounded context, in-process module → future service extraction map, API surface
ownership, and data-flow ownership.

**SERVICE_ARCHITECTURE.md has NOT been started automatically.**

