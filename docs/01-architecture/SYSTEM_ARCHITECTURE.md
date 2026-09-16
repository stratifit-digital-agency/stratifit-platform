# System Architecture

> **Bootstrap draft derived from operator architecture brief — pending human review**

## Overview

Stratifit Platform is one monorepo containing two separate applications over a shared
platform core:

```
                STRATIFIT PLATFORM
                        |
        +---------------+---------------+
        v                               v
STRATIFIT CONTROL                STRATIFIT MEDIA
Internal Application             Public Application
        |                               |
        +---------------+---------------+
                        |
                  PLATFORM CORE
                        |
        +---------------+---------------+
        |               |               |
     Database        Storage         Events
     Identity        Assets          Queues
     Auth            Search          Analytics
                        |
                  DOMAIN SERVICES
```

## Applications

- **Stratifit Control** (`apps/stratifit-control`) — internal, operator-only. Covers
  the full production operating system: AI Director, planning, productions, assets,
  models, workflows, compute, jobs, QC, publishing control, CMS, messaging, leads,
  analytics, administration, permissions, audit.
- **Stratifit Media** (`apps/stratifit-media`) — public, audience-first. Covers home,
  discover, titles, series, shorts, music, live, creators, search, trending, social
  interaction, notifications, messaging, contact. Public users are audience users and
  have no access to production capability.

## Content origin rule

Everything public originates internally:
Internal creation → Planning → Production → QC → Approval → Publication → Stratifit Media.

## Abstraction layers

- **Production Engine → Capability Contract → Model Router → Model Adapter → Selected
  Model.** Models evolve without rewriting the production engine; versions remain
  identifiable and reproducible.
- **Production Engine → Workflow Contract → Workflow Registry → Workflow Runtime**
  (ComfyUI initially, behind the abstraction).
- **Compute Manager → ComputeProvider → RunPod** (and future providers). Compute
  planning estimates GPU class, VRAM, workers, concurrency, runtime, storage, cost;
  actuals are recorded against estimates.

## Data and events

- PostgreSQL (Supabase-managed) holds structured metadata, relationships, state,
  permissions, provenance, publication records, and analytics references. Large media
  binaries live in object storage, never in PostgreSQL.
- Important state transitions emit typed domain events (e.g., `production.approved`,
  `job.completed`, `publication.published`, `message.created`). Event handlers are
  idempotent; events communicate state but never replace transactional domain state.

## Security boundaries

Public Browser → Stratifit Media → Public API/BFF → Authorized Domain Services →
Database/Storage/Events.
Internal Operator → Stratifit Control → Authorized Internal APIs → Domain Services →
Production Services → Compute Manager → GPU Workers.

Never trust the browser; enforce all authorization server-side; least privilege;
secure secret management; signed URLs for controlled media access; rate limiting;
audit logs. The browser never receives RunPod or provider credentials, worker
credentials, model provider secrets, storage administration credentials, or arbitrary
infrastructure access.

## AI authority

AI may interpret briefs, structure plans, suggest assets, generate prompts, select from
approved capabilities, analyze outputs, suggest revisions, and assist communication —
always through schema-validated outputs. Deterministic backend services enforce
authorization and execution. AI never receives unrestricted credentials, budget,
permission bypass, rights bypass, gate bypass, publication authority, security-control
authority, infrastructure command authority, or provenance-mutation authority.

## Implementation mapping (current foundation)

- Logical services are **in-process modules** in `services/*`, not deployable
  microservices; extraction happens only for real operational reasons.
- The Production Gate is a pure, testable rule evaluation over a plan/manifest draft.
- Publishing is a separate domain consuming publication records via a read API and
  platform adapters.
- The Media/Control boundary is mechanically enforced by ESLint import rules:
  Stratifit Media must never import compute, AI, workflows, database, storage, or the
  production engine.
- The domain database schema intentionally does not yet exist; it follows
  DOMAIN_MODEL.md.
