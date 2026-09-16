# Data Flow

> **Bootstrap draft derived from approved foundation and operator architecture brief — pending human review**

**Document Status.** This document is an **architectural specification** — the canonical
data-flow architecture for the Stratifit Platform, derived from the approved
DOMAIN_MODEL.md and SERVICE_ARCHITECTURE.md and the implemented foundation. It is a
bootstrap draft pending human review. **Implementation is deferred**; **database/schema
work is deferred**; **event architecture is deferred** (EVENT_ARCHITECTURE.md is a
separate future task); **API architecture is deferred** (API_ARCHITECTURE.md is a
separate future task). Nothing in this document authorizes code, schema, migrations,
APIs, workers, queues, or infrastructure. Every flow below names WHAT moves, WHERE it
moves, WHO owns it, WHEN it moves, WHY it moves, WHICH boundary it crosses, and WHICH
mechanism carries it.

## 1. Data Classes

Eight distinct classes. **They are never interchangeable** — each has its own owner,
persistence, transport, permitted boundaries, classification, and lifecycle. Treating
one as another (e.g., persisting a command, promoting an analytics event into domain
state, or letting raw provider data become domain records) is an architecture violation.

| # | Class | Owner | Purpose | Persistence | Transport | Allowed boundaries | Classification | Lifecycle |
|---|---|---|---|---|---|---|---|---|
| 1 | **Domain state** | Owning domain module (one per aggregate — §24) | Transactional truth (production status, conversation, lead, watch progress, budget counters) | PostgreSQL (Supabase-managed) via owning module | Module command APIs (in-process calls) | Owning module ↔ its callers; never cross-module table access | Operator-private; audience-private where audience-owned | Creation → allowed mutation → versioning → approval → publication → archival; immutable records never mutated |
| 2 | **Domain commands / requests** | Created by caller (BFF, module, worker); validated by callee module | Request a state change; carry intent + actor context | **None** — short-lived, non-authoritative; a rejected command leaves no trace | In-process function calls at Stage 1 (typed parameters) | App BFF → module; module → module (dependency graph); worker → module | Inherits actor's classification | Born at the boundary, consumed at the module, gone |
| 3 | **Domain events** | Emitting module (owns its event names) | Communicate **committed** state transitions | Envelope in transit; durable transport deferred (outbox seam at Phase 3) | `@stratifit/events`: `EventPublisher`, `DomainEventEnvelope`, `DomainEventName`; handlers `idempotent` by eventId | Any module → subscribers; never replaces domain state | Operator-private or public-safe per payload; **never** carries secrets | Emitted after commit; consumed idempotently; eventIds unique forever |
| 4 | **Analytics events** | `services/analytics` | Append-only observations (views, watch time, engagement, CTR, conversions, revenue, message/lead counts) | Append-only analytical store + read models | Batched intake (best-effort, non-blocking); `analytics.received` | Audience surfaces → intake; intake → read models → recommendations/editorial | Audience-private minimized (session refs, coarse device class); aggregates operator-visible | Written once; aggregated; retained per policy; **never written back into domain state** |
| 5 | **Read models / projections** | The module that projects them (search, recommendations, analytics read models; publishing public read API) | Fast, purpose-shaped reads; **rebuildable, never authoritative** | PostgreSQL read tables/indexes | Read APIs | Owning module → authorized readers; Media reaches only public read APIs | Public or operator-private per surface | Derived from domain state/events; rebuilt on demand; discardable |
| 6 | **Binary media** | `services/assets` owns the *reference*; object storage holds the *bytes* | Images, video, audio, renders, thumbnails, posters, subtitles, generated outputs | **Object storage** (`StorageProvider`) — never PostgreSQL | Direct upload/download via signed references; `StorageRef` (bucket, key, checksum, size, mime) in the DB | Adapters ↔ storage; assets module issues signed URLs at read time | Public (published versions), operator-private, or sensitive internal (rights evidence) | Put → referenced by AssetVersion → versioned/lineage-linked → published (visibility granted at publication) → retention per policy |
| 7 | **Infrastructure execution state** | Jobs module (attempts, leases); workers (run handles, heartbeats); delivery/transport layers | Make execution resumable and observable | PostgreSQL (job attempts immutable) or ephemeral (leases, heartbeats) | Module APIs (claim, progress, result); event payloads for progress | Workers ↔ jobs module only; never authoritative | Operator-private | Lease → attempt (immutable record) → terminal outcome; leases expire |
| 8 | **External-provider data** | The adapter that owns the integration; normalized results land with the owning domain module | Talk to RunPod, object storage, email, social platforms, LLM endpoints | **Raw responses are never persisted as domain state**; only normalized outcomes (opaque external ID, delivery outcome, usage record) persist, as references | Adapter calls at the boundary (E → G in SERVICE_ARCHITECTURE) | Adapter ↔ provider only; normalized result → owning module | Infrastructure-secret (credentials) + Public (external IDs are opaque references) | Request → raw response (transient) → normalized outcome → domain reference record; raw payloads discarded |

## 2. Data Flow Principles

1. **One authoritative owner per data object.** Writes only through the owning
   boundary; cross-domain references use IDs.
2. **Commands are short-lived and non-authoritative.** Validated, executed, discarded;
   no command store, no event sourcing, no CQRS.
3. **State owns transactional truth.** Events communicate; they never replace state.
4. **Events communicate committed transitions.** Emitted after the state change is
   committed; handlers idempotent by eventId.
5. **Binaries never transit PostgreSQL.** The database stores metadata and
   `StorageRef`s; object storage holds media.
6. **External provider responses normalize at adapters.** Raw payloads are transient
   infrastructure data; only normalized outcomes persist.
7. **Workers never own domain state.** They execute and report; the owning module
   remains authoritative.
8. **Failures are isolated.** Each failure marks the narrowest artifact and leaves the
   authoritative state valid.
9. **Correlation IDs travel with flows.** The envelope's correlation set
   (organization, project, production, scene, shot, generation, asset, job,
   publication, conversation, campaign) accompanies commands, events, and jobs.
10. **Data classification gates channels.** A datum may only traverse a channel its
    classification permits (§4).

## 3. Trust Boundaries

Two major flows, with the **seven enforcement moments** where identity,
authorization, verification, or classification is enforced:

```
DIAGRAM 1 — PLATFORM OVERVIEW (also the trust-boundary map)

  PUBLIC CHAIN
  Browser ──(1)──► Stratifit Media UI ──(2)──► Media BFF ──(3)──► public-safe services
       ◄────────────────────────────────────────────────────────┘
              read models / data ◄───────────────────────────┘

  INTERNAL CHAIN
  Operator ──(4)──► Stratifit Control UI ──(5)──► internal BFF ──► domain services
       ──► domain state (PostgreSQL) ──► jobs/events ──► compute/workers
       ──► storage (object) ──► QC ──► publishing ──► Public Content
                                                     │
                     (public content readable via public read APIs) ◄── Media BFF
```

| Moment | Enforcement |
|---|---|
| 1. Browser → Media UI | Nothing trusted; no authorization decided client-side |
| 2. Media UI → Media BFF | Request arrives; identity is **never** taken from client claims |
| 3. Media BFF → public-service | Identity resolved server-side (`services/identity`); audience verification enforced via the pure rule in `@stratifit/auth`; only `public-service` modules reachable (lint-enforced blocklist for internal infrastructure) |
| 4. Control UI → Control BFF | Operator session resolved server-side |
| 5. Control BFF → internal services | Capability check via `@stratifit/permissions` matrix |
| 6. Module → adapter | Composition root injects credentials (server-only; SUGGESTION 6 of SERVICE_ARCHITECTURE) |
| 7. Adapter → external provider | Credentials leave the platform exactly here, per call |

## 4. Data Classification

| Class | Examples | Permitted channels | Never enters |
|---|---|---|---|
| **Public** | published content metadata, public profiles, slugs/handles | public read APIs; browsers | internal-only channels unproblematically; no restriction |
| **Audience-private** | watch progress, notifications, own conversations, like/comment attribution | Media BFF after identity check; owner-scoped reads | other audience members; operator dashboards only as aggregates |
| **Operator-private** | production state, plans, manifests, QC records, campaigns, aggregate analytics | Control BFF after capability check | browsers; public APIs |
| **Sensitive internal** | rights evidence refs, AI communication configs, moderation flags, budget detail | internal APIs + audit trail | any client-facing response; public API payloads (publication snapshots carry publishable fields only) |
| **Infrastructure-secret** | RunPod, storage, worker, email, LLM credentials | **adapter constructors only** (injected at composition roots) | **browser, API responses, domain entities, event payloads, persistent business records** — absolutely, invariant 4 |

Classification is a property of the datum and travels with it: publication snapshots
contain only publishable fields; audience responses are owner-scoped; analytics
events carry session refs and coarse device class, never raw PII.

## 5. Public Media Flows

All 18 flows. Media BFF is the only door; only `public-service` modules are reachable.
**Verification rules (documented, not implemented):** authentication is required for
like, follow, comment, share, and message; **email verification is additionally
required for comment, share, and message**; watching may remain anonymous.

1. **Anonymous viewing** — content request → Media BFF → publishing/audience public
   read APIs → public metadata + signed media URLs → playback; watch events →
   analytics intake keyed by an opaque session ref (Open Question 2). No user row; no
   watch progress. Mechanism: synchronous read; async analytics event.
2. **Authenticated viewing** — as above; identity resolved server-side; watch
   progress written via the audience command API (transactional domain state); watch
   events to analytics.
3. **Creator profile viewing** — public profile read API (publication-created
   snapshot from the people module's public-safe fragment); internal AI-creator IDs
   never exposed; handle/slug only.
4. **Following** — authenticated command → social module (asymmetric follow row;
   unique per follower/followee-kind/followee).
5. **Liking** — authenticated command → social module; unique (user, content).
6. **Commenting** — authenticated + email-verified command → social module (threaded
   via parent comment ref; visibility states).
7. **Sharing** — authenticated + email-verified; share recorded with channel
   (Open Question 1 on semantics).
8. **Saving** — authenticated command → social module; unique (user, content).
9. **Email verification** — provider-external flow; the result lands as
   server-derived `emailVerified` state (never a client flag); requirements are
   seeded data (`verification_requirements`), extensible without redesign.
10. **Messaging** — verified command → Media BFF → messaging public-safe fragment →
    Conversation aggregate (see §16).
11. **Human takeover** — internal: operator via Control (`messaging.takeover`) →
    assignment + audit event; subsequent messages carry author kind `human`.
12. **Service inquiry** — message classified (AI with confidence, or human) →
    service-inquiry record inside the messaging module.
13. **Lead creation** — inquiry → Lead aggregate (`new`); visible in the Control
    inbox with AI profile, viewer, and transcript.
14. **Notifications** — domain events (`message.created`, social.*, `publication.published`)
    → notifications module (eligibility + records); delivery fan-out is a Stage 2
    worker; failure never rolls back the origin (§23).
15. **Search** — query → search read model (public content + public creator metadata
    only) → results.
16. **Recommendations** — session/user → recommendation read models built from
    analytics only → ranked candidate set.
17. **Watch progress** — authenticated command → audience module; upsert per
    (user, content); powers "continue watching"; not required for anonymous viewers.
18. **Analytics collection** — batched analytical events → analytics intake
    (`analytics.received`); best-effort and non-blocking; ingestion failure never
    invalidates the originating transaction.

```
DIAGRAM 2 — PUBLIC MEDIA FLOW (viewer session)

 Browser ──► Media UI ──► Media BFF ──(identity/verification)──► public-service modules
    ▲                                                        │
    │            metadata + signed media URLs                │ reads: publishing read API,
    └────────────────────────────────────────────────────────  │ audience, social, messaging,
                                                               │ notifications, search, recs
   commands (like/follow/comment/share/message/progress) ──────┘
   analytics events (batched, best-effort) ──► analytics intake
   internal IDs never cross the BFF response boundary (slugs/handles only)
```

## 6. Identity / Verification Flow

```
request → auth subject (server session) → services/identity.resolveIdentity
        → Identity (operator | audience | null)
        → authorization:
            audience actions: authorizeAudienceAction(identity, action)
              (email gates comment/share/message; like/follow need authentication)
            internal actions: capability matrix (@stratifit/permissions)
        → domain operation
```

Verification state is **server-derived** from the auth provider; client-provided
verification flags are never trusted. Requirements are data-driven
(`verification_requirements` seeded with comment/share/message → email). No
implementation — data-flow rule only.

## 7. Content Publication Flow

```
DIAGRAM 3 — CONTENT PUBLICATION (end-to-end)

 Internal Production ──► Production Gate (pure) ──► Manifest ──► Jobs
   ──► Generation ──► Assets ──► QC ──► Approval ──► Publishing
   ──► Publication Version (immutable snapshot) ──► Platform Adapter
   ──► Public Content ──► Stratifit Media
```

The publication payload references the **master** (root lineage asset version) and
its **derivatives**: thumbnails, posters, trailers, subtitles, localized variants
(§14), and platform-specific variants produced by adapters or media processing — all
derived asset versions with lineage edges back to the master. **Failure isolation**:
a failed publication marks the distribution attempt `failed`; the master and the
production remain valid; re-delivery is a publication state transition
(`failed → pending_approval`).

## 8. AI Planning Flow

```
DIAGRAM 4 — AI PLANNING

 Creative Brief (operator)
   ──► AI Director (LLM via packages/ai) ──► SCHEMA-VALIDATED SUGGESTIONS
   ──► Planning (production-engine) ──► Project / Production / Scene / Shot /
        Asset Plans ──► Model + Workflow selection (registry VERSIONS only)
   ──► Compute estimation (pure) ──► Production Gate (deterministic)
   ──► Gate Decision Record (immutable) ──► Manifest
```

**AI suggestions** (plans, prompts, selections, analyses) are data — commands that
enter domain state only through authorized module operations (Planning's command
API). **Deterministic validation** (gate checks, rights evaluation, compatibility,
budget) is code. AI never bypasses protected domain operations and never mutates
immutable provenance (PRINCIPLES 4).

## 9. Production Flow

```
Production → Scene → Shot → Generation Request → Job → Compute Allocation
  → Worker → Workflow Runtime → Model Adapter → Generation → Asset
  → QC → Approval → Master → Derivatives → Publication
```

- **Dependency graph**: shots within scenes; job DAG edges (B starts after A reaches
  a terminal state); cycles rejected (invariant 22).
- **Retries**: job-level, same idempotency key, up to max attempts.
- **Idempotency**: (job type, subject, key) dedupes retries.
- **Failure behavior**: a failed generation never destroys the production — the job
  fails/retries, or a new generation continues the lineage; production state
  machine returns via `changes_requested`/re-plan when needed.
- **Checkpoints**: where the job type supports them, resume runs from checkpoint
  refs rather than restarting.
- **Status updates**: `production.updated` events on transitions; job progress
  events during execution.
- **Provenance**: pinned at every hop — plan version → manifest version → job →
  attempt → generation (full field set, §10).

## 10. Generation / Provenance Flow

The full provenance set travels **with** the generation record and becomes
**immutable at completion**:

production ID · scene ID · shot ID · generation ID · parent generation · input asset
versions · model ID + **model version** · workflow ID + **workflow version** ·
prompt · negative prompt (where applicable) · seed · parameters · resolution · FPS ·
duration · adapters/LoRAs (weights by version, where applicable) · runtime version ·
worker/GPU reference (platform-agnostic; never credentials) · timestamps (requested/
started/completed) · estimated cost · **actual cost** · runtime.

**Immutable provenance**: fields are written once at completion and never edited
(invariant 3). Corrections are **superseding records** (a new generation or a new
version row), never updates. Generation lineage forms DAGs via parent references;
parents are never mutated. Model/workflow upgrades create new registry versions and
never destroy the reproducibility of historical generations.

```
DIAGRAM 5 — GENERATION FLOW (with provenance write-once)

 Manifest selections ──► Generation Request (command) ──► Job ──► Attempt
   ──► Workflow Runtime + Model Adapter execute ──► output bytes
   ──► ObjectStorage.put ──► StorageRef
   ──► generation module: completion record (provenance set, WRITE-ONCE)
   ──► assets.registerVersion (same transaction, Open Question 6)
   ──► generation.completed event ──► QC enqueue
```

## 11. Asset / Storage Flow

```
DIAGRAM 6 — ASSET / STORAGE

 Input AssetVersion ──► Generation ──► output bytes ──► Object Storage
   ──► StorageRef {bucket, key, checksum, byteSize, mimeType}
   ──► AssetVersion row (immutable; version number; technical metadata)
   ──► lineage edge (derivation kind: generation|edit|transcode|thumbnail|
        trailer|upscale|enhancement)
   ──► derivatives (thumb/poster/trailer/subtitle/localized) ──► QC
   ──► Publication references asset versions
```

- **PostgreSQL holds**: metadata, relationships, versions, lineage, approval state,
  visibility, `StorageRef`s. **Object storage holds**: images, video, audio,
  renders, thumbnails, posters, subtitles, generated outputs. Large binaries never
  transit PostgreSQL (invariant 21).
- **Signed URLs** are issued **at read time** by the assets module via
  `StorageProvider.signedUrl(key, expiresInSeconds)` — expiry-scoped, never stored,
  never client-forgeable (SUGGESTION 1 makes the assets module the sole issuance
  point).
- **Checksums** verify outputs against their provenance.
- **Versions + lineage**: append-only; parent versions never rewritten; cycles
  rejected (invariants 24–25).
- **Visibility** (`internal` → `public`) is granted at **publication**, never by
  flipping a flag on the asset.

## 12. Compute Flow

```
Job (compute requirement) ──► Compute Manager.estimate (pure) ──► allocation
  ──► ComputeProvider ──► provider (RunPod today — stub; future providers additive)
  ──► Worker executes ──► progress events ──► usage record
      (actual runtime + actual cost) ──► estimate-vs-actual improves planning
```

RunPod is **only a provider** (a reference string on allocations/usage); ComfyUI is
**only a runtime implementation** (a runtime-type identifier); neither is a domain
data owner (invariant 20). **Credentials** exist only at the adapter/composition-root
boundary (trust moment 6–7) and appear in no command, row, event, or response.
Failure → allocation/attempt marked failed → retry with the same idempotency key;
the job's domain subject is untouched.

## 13. Worker Flow

Workers receive **minimal execution input** — references, not aggregates:

```
Job (claimable, lease-based — SUGGESTION 4) ──► Worker claim
  ──► execution input: workflow + version refs · model refs · input StorageRefs
        (signed, expiry-scoped) · parameters · idempotency key · checkpoint refs
  ──► execution ──► output bytes ──► storage.put
  ──► result metadata ──► module API (attempt outcome + usage) ──► domain state
  ──► event (job.completed / generation.completed / …)
```

Workers **never become authoritative domain-state owners** (Principle 7): all state
stays in module-owned tables; workers write back through module APIs only;
infrastructure execution state (leases, heartbeats, run handles) is non-authoritative
and expires. A crashed worker's lease expires; the attempt is recorded (immutable);
the job is retried or resumed from its checkpoint.

## 14. Localization Flow

```
Master ──► Localization Plan (operator)
  ──► per language: Voice/Dubbing (generation, voice.synthesis capability)
    ──► Lip Sync where required (capability) ──► Subtitles (derived assets,
        lineage edge) ──► localized metadata
  ──► QC per variant ──► Publication variant(s) with language refs
  ──► Public Content (availability window carries geo/language)
```

Localized content remains **derived from the master** — localized variants are
derived asset versions + publication-version metadata, never a second content
universe (invariant 10 preserved). Nothing is implemented; the flow supports the
existing multilingual architecture.

## 15. Publishing Flow

```
Approved subject ──► Publication ──► Publication Version (immutable snapshot)
  ──► Distribution attempt ──► Platform Adapter ──► external platform
  ──► NORMALIZED result {opaque external ID, delivery outcome}
  ──► Distribution Reference (immutable) ──► publication.published | publication.failed
```

**Raw provider responses never become domain state** — the adapter normalizes at the
boundary (Principle 6); only the opaque external ID and outcome persist. For
stratifit-media the external ID is the public content slug. **Failure isolation**: a
failed delivery marks the distribution attempt; the master and production stay valid;
`failed → pending_approval` re-delivery; retries of the same publication version
must be tolerated by adapters (idempotency §21).

## 16. Messaging Flow

```
DIAGRAM 7 — MESSAGING (AI reply and human takeover)

 Viewer ──► Creator Profile ──► Message action ──► Media BFF
    ──(identity + email verification)──► messaging module
    ──► Conversation(open) ──► Message(author=human) ──► message.created
    ──► Communication Engine (orchestration sub-module; packages/ai)
    ──► AI draft (schema-validated) ──► Message(author=ai) via messaging API
    ──► Conversation(awaiting_ai → active) ──► Notification

 Human takeover:
 Operator ──► Control ──► takeover command (messaging.takeover)
    ──► assignment + audit event ──► Message(author=human) ──► Viewer
```

Message author kinds are **`ai` | `human` | `system`** (from the existing
`MessageAuthorKind` contract) — every conversation view (Media and Control inbox)
distinguishes them. The Communication Engine **cannot bypass messaging ownership or
permissions**: it consumes `message.created` events and writes its replies through
the messaging module's own command API (author kind `ai`); it holds no tables and no
direct DB access.

## 17. Lead Flow

```
Content ──► Creator Profile ──► Conversation ──► Service Inquiry
  (classification + confidence, AI or human) ──► Lead(new)
  ──► triage ──► Assignment (operator, lead.assign) ──► Human takeover if needed
  ──► Follow-ups (immutable records) ──► Conversion outcome (won|lost|archived)
  ──► Analytics reference
```

Lead transitions are recorded audit events, never silent updates. No CRM
functionality is implemented; leads are messaging-module aggregates exposed to
Control.

## 18. Advertising Flow

```
DIAGRAM 8 — ADVERTISING

 Brand ──► Campaign (brief, audience target, budget) ──► Creative Planning
   ──► [optional] Production (normal gate/manifest pipeline)
   ──► Creative Variants (→ experimentation hooks) ──► QC ──► Publishing
   ──► Distribution ──► Analytics (performance refs by campaign/creative/
        publication IDs)
```

Supports all three modes — external business advertising, sponsored entertainment,
Stratifit self-promotion — which differ only in brand owner and objective. **No
special publication bypass**: public campaign content goes through the same
publishing engine and adapters as everything else.

## 19. Analytics Flow

Three families, strictly separated (invariant 15): **transactional domain state ≠
domain events ≠ analytics events**.

```
DIAGRAM 9 — ANALYTICS FEEDBACK LOOP

 Audience action ──► analytical event (views · watch time · retention · completion ·
   likes · comments · shares · follows · CTR · conversions · revenue · messages ·
   leads — each carrying its domain references)
   ──► analytics intake (best-effort, idempotent, non-blocking)
   ──► append-only analytical storage ──► aggregation ──► read models
   ──► Recommendation Engine + Editorial dashboards (Control)
   ──► new creative briefs ──► AI Director ──► next production
```

Ingestion failure never invalidates the originating domain transaction (drop/buffer,
never block). Analytical events are **never written back into domain state**.

## 20. Recommendation Flow

```
Audience behavior ──► analytics ──► read models ──► Recommendation Engine
  (consumes analytical/read models ONLY — never production transactional state)
  ──► ranked candidate set ──► Media BFF ──► viewer interaction ──► new analytics
```

A closed loop with no algorithm defined here; the recommendation engine holds only
its own read models.

## 21. Search Flow

```
Published content + public creator metadata ──► search index / read model
  (updated on publication.published and profile changes) ──► query layer
  (public-service) ──► results ──► Media
```

No search infrastructure is implemented; the index is a rebuildable projection of
public-safe data only.

## 22. Notification Flow

```
Domain event (message.created | social.* | publication.published | system)
  ──► Notification eligibility (recipient, kind, preferences)
  ──► Notification record (notifications module)
  ──► Delivery (email/push/in-app — Stage 2 worker)
  ──► Delivery result (infrastructure execution state)
```

Examples: message, follow, comment, publication-of-followed-creator, system. **A
failed delivery never rolls back the originating domain action** (invariant 6): the
message stays sent; delivery results are retryable infrastructure records keyed by
notification ID.

## 23. Event Flow

The **only** event system is the existing `@stratifit/events` contract:
`EventPublisher` · `DomainEventEnvelope` (eventId idempotency, name, sequence,
occurredAt, correlation set, validated payload) · `DomainEventName` names ·
`idempotent` handlers.

```
committed state change (transactional, in the owning module)
  ──► domain event (envelope) ──► consumers (idempotent by eventId)
```

Documented chains: `generation.completed` → QC enqueue; `asset.approved` →
publishing eligibility; `publication.published` → public content + notifications +
profile re-snapshot (via people API); `message.created` → notifications +
communication engine + lead classification; `analytics.received` → read models;
`production.approved` → jobs enqueue (synchronous call) + audit append.

**Events are NOT authoritative transactional state** — the state change commits
first; the event communicates. The current in-process publisher has no
transactional/outbox guarantee; the **durable/outbox seam is documented as
architecture** (arrives with the Job Engine at Phase 3; the `EventPublisher`
interface does not change) and is **not implemented** here. Event-name extensions
require contract changes gated on approval (EVENT_ARCHITECTURE.md's future scope).

## 24. Data Ownership

Every domain object has **one authoritative owner** (SERVICE_ARCHITECTURE §11):

| Data | Owner |
|---|---|
| Production state (projects, plans, gate decisions, manifests) | production module |
| Assets, versions, lineage | assets module |
| Generations + provenance | generation module |
| Publications, versions, distribution refs | publishing module |
| Conversations, messages, service inquiries, leads | messaging module |
| Public content, audience state, watch progress, experiments | audience module |
| Social graph rows | social module |
| Notification records | notifications module |
| Analytical records + read models | analytics module |
| Identity/tenancy rows, verification requirements | identity module |
| Model/workflow registry rows | packages/ai, packages/workflows |
| Audit log | admin-audit module |

**Cross-domain references use IDs. No cross-module database writes** — the only
sanctioned cross-module writes go through owning-module APIs
(`assets.registerVersion`, `people.publishProfileSnapshot`, `jobs.enqueue`,
`admin-audit.append`).

## 25. Read Flows

| Kind | Mechanism | Consumers |
|---|---|---|
| **Authoritative domain reads** | owning module's read API, capability-checked | Control BFF |
| **Public read APIs** | public-service read surfaces (publishing `PublicationReader` today; audience/social/messaging/notifications/search/recommendations fragments later) | Media BFF |
| **Projections / read models** | rebuildable tables/indexes maintained by their owning module | search, recommendations, dashboards |
| **Analytics read models** | analytics module aggregations | Control editorial intelligence, recommendation engine |
| **Cached data where appropriate** | short-lived response caches at the BFF | any — caches hold only what the underlying read may return |

**Media must never directly query internal production tables** — it reads only
public read APIs (mechanically enforced by the ESLint boundary). Media responses
expose slugs/handles, never internal IDs of production entities.

## 26. Write Flows

All writes pass through the owning boundary:

- Media BFF → public-service command APIs (identity + verification enforced).
- Control BFF → internal module APIs (capability enforced).
- Module → module **only** via the callee's public API along the dependency graph.
- Workers → module attempt/result APIs.

**Never**: Media → internal database; Module A → Module B tables. Use the module API
or the appropriate domain event. A rejected command leaves no trace (Principle 2).

## 27. Failure Flows

```
DIAGRAM 10 — FAILURE / RETRY (isolation map)

 Generation fails ──► attempt fails ──► retry / new generation (lineage kept)
                                       └─► production survives
 QC fails ──► publication blocked ──► asset/generation survive
 Publication fails ──► distribution marked failed ──► master survives
 Notification fails ──► delivery fails ──► message survives
 Analytics ingestion fails ──► event dropped/buffered ──► transaction survives
 Worker crashes ──► lease expires ──► attempt fails ──► retry / checkpoint resume
 External provider fails ──► normalized failure at adapter ──► domain state valid
```

Every failure marks the **narrowest** artifact (attempt, distribution, delivery,
lease) and leaves the authoritative domain state valid — the systematic application
of Principle 8 and PRINCIPLES 13.

## 28. Retry / Idempotency

Idempotency is **required** at:

| Location | Key | Behavior |
|---|---|---|
| **Jobs** | (job type, subject, idempotency key) — unique | retries dedupe; max attempts enforced |
| **Workers** | same idempotency key on re-execution | re-running a delivered job must not double-produce; checkpoint resume where supported |
| **Event handlers** | eventId | `idempotent` wrapper today; durable dedup table at the outbox seam |
| **Publication delivery** | (publication version, target) | adapters tolerate redelivery of the same version |
| **Notifications** | notification ID | re-delivery does not duplicate |
| **Retryable generation execution** | generation idempotency within its job | a retry beyond the runtime creates a **new** generation whose lineage preserves the parent chain |

No retry infrastructure is implemented; the table specifies locations and keys only.

## 29. Security Data Flow

```
DIAGRAM 11 — SECURITY / TRUST (credential and identity movement)

 Authentication context:  server session ──► identity resolution (moment 3/5)
 Authorization context:   capability matrix / verification rule ──► BFF gate
 Verification state:      server-derived from auth provider (never client flags)
 Rights state:            rights verdicts ──► gate + publishing (fail-closed)
 Signed StorageRefs:      assets module ──► per-read, expiry-scoped URLs
 Provider credentials:    Composition Root ──► Adapter Constructor ──► provider
                          (moments 6–7; the ONLY credential path)
```

Credentials **never** enter: the browser, API responses, domain entities, event
payloads, or persistent business records (invariant 4). Signed storage references are
issued per read and never stored. Rights evaluation is fail-closed: an invalid or
expired grant blocks generation and publication.

## 30. Observability Data Flow

```
Request ──► correlation ID assigned at the BFF ──► domain operation
  (module logs + audit where required) ──► job/event (envelope correlation set)
  ──► worker ──► provider call ──► result
```

Correlation dimensions travel with every flow (from the envelope's correlation set):
organization · project · production · scene · shot · generation · asset · job ·
publication · conversation · message · campaign. Every section above names its IDs;
observability **infrastructure** (OpenTelemetry, Sentry, metrics) is not implemented.

## 31. Data Lifecycle

```
Creation (command) ──► allowed mutation (aggregate status; current pointers only)
  ──► versioning (immutable version rows) ──► approval (gate + QC decisions)
  ──► publication (snapshots) ──► archival (production archived / content
  unpublished / experiment archived) ──► retention/deletion (audience deletion
  requests; analytics retention windows; takedown leaves provenance intact)
```

**Immutable records** (written once; corrections supersede, never overwrite):
generations/provenance · asset versions · model versions · workflow versions · gate
decisions · QC decisions · distribution references · messages · audit records ·
event IDs. Takedown (`published → unpublished`) withdraws public availability but
never rewrites history.

## 32. Data Flow Diagrams

The twelve major diagrams, in place:

| # | Diagram | Section |
|---|---|---|
| 1 | Platform overview / trust boundaries | §3 |
| 2 | Public Media flow | §5 |
| 3 | Content publication (end-to-end) | §7 |
| 4 | AI planning | §8 |
| 5 | Generation (with provenance write-once) | §10 |
| 6 | Asset / storage | §11 |
| 7 | Messaging (AI reply + takeover) | §16 |
| 8 | Advertising | §18 |
| 9 | Analytics feedback loop | §19 |
| 10 | Failure / retry (isolation map) | §27 |
| 11 | Security / trust (credential + identity movement) | §29 |

with the QC → publication handoff embedded in Diagrams 3 and the publishing adapter
normalization in §15 (Diagram 12 below):

```
DIAGRAM 12 — QC → PUBLISHING HANDOFF

 Subject (asset version | generation | production | publication) ──► QC request
   ──► checks (technical | moderation | rights | editorial) ──► results + issues
   ──► Review ──► approved | rejected | changes_requested
   ──► publication eligibility (approved subjects only)
   ──► Publishing Engine ──► PlatformAdapter ──► normalized result
```

QC failures **block publication** (a subject publishes only from an `approved` QC
review state); QC decision records are immutable.

## 33. Open Questions

Exactly the eight approved questions. Each: Question / Why it matters /
Recommendation / **Decision required: YES**.

1. **Share semantics.**
   Question: is a "share" a server-recorded event (actor, channel, content) or purely
   a client-side distribution of a link?
   Why it matters: defines what data a share creates, what the email-verification
   gate actually gates, and what analytics counts.
   Recommendation: server-recorded share event with channel; verification gates
   *recording*, not link copying.
   Decision required: YES.

2. **Anonymous session identity.**
   Question: what opaque reference identifies an anonymous viewer, and how is it
   issued/rotated?
   Why it matters: powers anonymous analytics and "continue watching" eligibility
   without user rows; has privacy implications.
   Recommendation: opaque session ref issued by the Media BFF, rotated periodically,
   no PII.
   Decision required: YES.

3. **Watch-event granularity.**
   Question: start/stop pairs, periodic heartbeats, or completion-only events?
   Why it matters: drives analytics volume, retention/completion accuracy, and
   intake cost.
   Recommendation: start + heartbeats + completion, server-side session windows;
   sample at scale.
   Decision required: YES.

4. **Media delivery path.**
   Question: signed URLs direct to object storage, or proxied/adaptive streaming
   through Media?
   Why it matters: latency, bandwidth cost, playback-count fidelity, geo
   enforcement.
   Recommendation: signed URLs direct; playback counts via analytics intake, not
   the delivery path.
   Decision required: YES.

5. **Analytics intake transport.**
   Question: batched client beacons vs server-side collection; delivery guarantee
   and loss tolerance?
   Why it matters: defines intake API shape, idempotency needs, and infrastructure
   class.
   Recommendation: batched beacons → Media BFF → intake; at-least-once with eventId
   dedup; loss acceptable (non-authoritative family).
   Decision required: YES.

6. **Generation output registration across processes.**
   Question: at Stage 2 the worker calls the generation module API cross-process —
   is asset registration inside the same transaction as generation completion, or
   event-driven with reconciliation?
   Why it matters: provenance continuity (no generation "completed" without its
   output registered) vs coupling.
   Recommendation: worker → generation module API; the module registers the output
   via the assets API in the same DB transaction as completion; events follow
   commit.
   Decision required: YES.

7. **Publication payload normalization scope.**
   Question: exactly which publishable fields ride a publication version to
   adapters?
   Why it matters: classification boundary (public fields only) and adapter
   stability across targets.
   Recommendation: a fixed normalized payload schema (title, synopsis, contentType,
   media refs, metadata snapshot); extensions additive.
   Decision required: YES.

8. **Control UI progress transport.**
   Question: polling read APIs vs subscriptions for job/production progress?
   Why it matters: UX freshness vs complexity before realtime infrastructure
   exists.
   Recommendation: polling read APIs at Stages 1–2; subscriptions only with the
   live/realtime phase.
   Decision required: YES.

## 34. Architectural Suggestions

Exactly six, all **not implemented**:

1. **SUGGESTION** — What: signed-URL issuance owned by the **assets module** as a
   public-safe read fragment (Media requests URLs through public read APIs, never
   holding storage credentials).
   Why: makes the infrastructure-secret classification airtight; one auditable seam
   for controlled media access.
   Impact: one API method + fragment classification.
   Changes approved architecture: NO.

2. **SUGGESTION** — What: analytical events reuse the envelope discipline (eventId,
   occurredAt, correlation set) with their own payload schemas — **without**
   touching `DomainEventName`.
   Why: uniform idempotency and observability across the two event families without
   conflating them.
   Impact: schema reuse only.
   Changes approved architecture: NO.

3. **SUGGESTION** — What: publication eligibility as a **pure function in
   quality-control** (mirroring `evaluateProductionGate`), consumed by publishing.
   Why: the same testability and single source of truth for "what may publish";
   publishing never implements QC rules.
   Impact: one pure function.
   Changes approved architecture: NO.

4. **SUGGESTION** — What: job claiming defined as **lease-based** semantics in the
   jobs module API (lease until completion/timeout; expiry recovers crashed
   workers).
   Why: crash recovery without orphaned jobs; makes worker idempotency
   well-defined.
   Impact: API design note only.
   Changes approved architecture: NO.

5. **SUGGESTION** — What: analytics intake contractually **best-effort and
   non-blocking** (bounded buffer, drop-oldest under pressure).
   Why: enforces "ingestion failure never invalidates domain transactions"
   mechanically rather than by discipline.
   Impact: intake API contract note.
   Changes approved architecture: NO.

6. **SUGGESTION** — What: privacy-minimized anonymous watch events — rotating
   opaque session refs, coarse device class only, no IP/UA persistence in
   analytical events.
   Why: anonymous watching must not become covert tracking; keeps the audience rule
   trustworthy.
   Impact: analytics schema constraint.
   Changes approved architecture: NO.

## 35. Contradictions Check

Checked against SYSTEM_ARCHITECTURE.md, DOMAIN_MODEL.md, SERVICE_ARCHITECTURE.md,
all five foundation documents, existing contracts, and the current package/service/
application boundaries (including the Media boundary). **Contradictions found:
none.** The four known tensions are reported, **not fixed**:

1. **`EMAIL_VERIFIED_ACTIONS` omits `message` while `@stratifit/auth` gates it** —
   inherited from DOMAIN_MODEL (SUGGESTION 6 there) and SERVICE_ARCHITECTURE §29;
   still open; this document follows the authoritative `@stratifit/auth` rule
   (email verification required before messaging). Not modified in this task.
2. **`InMemoryPublicationStore` does not yet represent immutable publication version
   rows** — it mutates record status in place, while DOMAIN_MODEL requires immutable
   publication *versions* with status on the publication entity. The in-memory store
   is a development placeholder; this specification describes version-row immutability
   for implementation. Not modified in this task.
3. **`PublicationRecord.contentType` is narrower than the eventual public-content
   taxonomy** — the contract enum lacks comedy, skit, music-video, live-program,
   advertisement. A contract extension will be needed at the public-content phase.
   Not modified in this task.
4. **Like/follow require authentication but not email verification** — confirmed in
   code (`REQUIREMENTS` in `packages/auth`) and consistent with the approved
   architecture; documented in §5 so flows neither over-restrict nor under-restrict.
   Not modified in this task.

## 36. Verification

Checklist against the authoritative inputs:

1. Complete production lifecycle — ✅ §9 (gate → manifest → job → generation chain;
   dependencies, retries, idempotency, checkpoints, status, provenance).
2. Complete publication lifecycle — ✅ §7, §15, §14 (master → derivatives →
   localization → publication versions → adapters → public content; failure
   isolation verified against `PublishingEngine.publish` in code).
3. Public/internal separation — ✅ §3 trust chains + seven moments; §25/§26 read/
   write rules; matches the ESLint Media boundary.
4. Ownership correctness — ✅ §24 (one owner per data object; SERVICE_ARCHITECTURE
   §11 families).
5. No cross-module DB writes — ✅ §26 (module APIs / events only).
6. Provenance continuity — ✅ §10 (full field set; write-once; superseding
   corrections).
7. Rights/consent continuity — ✅ §29 (fail-closed verdicts into gate and
   publishing).
8. Compute abstraction — ✅ §12 (provider reference only; credentials at
   adapters).
9. Worker isolation — ✅ §13 (minimal input; module-API writeback;
   non-authoritative execution state).
10. Event/state separation — ✅ §23 (existing contract only; committed state first).
11. Analytics separation — ✅ §19 (three families; never written back).
12. Failure isolation — ✅ §27 (isolation map).
13. Retry/idempotency — ✅ §28 (six locations with keys).
14. Messaging/human takeover — ✅ §16 (author kinds; takeover as command + audit).
15. Advertising — ✅ §18 (three modes; no publication bypass).
16. Localization — ✅ §14 (derived variants; no second universe).
17. Security — ✅ §4, §29 (classification-gated channels; single credential path).

No code changed; no schema/migration change; no event/API architecture implemented.

## 37. Deferred Implementation

All flows above are specifications. Deferred: verification enforcement; durable
conversations and the AI Communication Engine; analytics intake infrastructure;
workers/queues (BullMQ/Redis); storage wiring and signed-URL issuance; external
publishing adapters; localization; search and recommendation engines; notification
delivery; observability tooling; the durable/outbox event transport; the relational
domain schema. **Nothing in this task is implemented.**

## 38. Recommended Next Task

**Recommended Next Task: EVENT_ARCHITECTURE.md** — the event-name contract
extensions, consumer/ownership map, idempotency and transport evolution (in-process
→ outbox), and the event/state boundary in depth, per ROADMAP Phase 1. API
architecture (API_ARCHITECTURE.md) follows.

**EVENT_ARCHITECTURE.md has NOT been started automatically** — nor has
API_ARCHITECTURE.md.
