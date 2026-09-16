# Stratifit Platform

AI-native media and entertainment operating platform — one monorepo, two applications:

- **Stratifit Control** (`apps/stratifit-control`) — internal Control Room / production operating system for authorized Stratifit operators.
- **Stratifit Media** (`apps/stratifit-media`) — public, audience-first entertainment and social platform.

Both share a common platform core (`packages/*`) and backend domain modules (`services/*`).

> **Implementation scaffolding note** — this README documents how the repository is
> wired, not finalized architecture. Finalized architecture lives in `docs/` once
> approved by human review.

## Structure

```
stratifit-platform/
├── apps/
│   ├── stratifit-control/   # Internal application (authorized operators)
│   └── stratifit-media/     # Public application (audience users)
├── services/                # In-process domain modules (not deployables yet)
│   ├── production-engine/
│   └── publishing-engine/
├── packages/
│   ├── contracts/  # Shared Zod schemas — single source of shared types
│   ├── database/   # Drizzle ORM on PostgreSQL
│   ├── auth/       # Identity types + Supabase session helpers (not wired yet)
│   ├── permissions/# Role → capability matrix (pure functions)
│   ├── events/     # Typed domain event envelope + publisher interface
│   ├── storage/    # Object-storage abstraction (local dev adapter)
│   ├── ai/         # Model capability contracts, adapters, registry
│   ├── workflows/  # Workflow contracts, registry, runtime abstraction
│   ├── compute/    # ComputeProvider abstraction (RunPod behind it)
│   └── ui/         # Shared Tailwind preset + primitives
├── docs/
├── openspec/
├── infrastructure/
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## Architecture boundaries (mechanically enforced)

Dependency direction is one-way, cycle-free, and enforced by ESLint
(`eslint.config.mjs`, `eslint-plugin-boundaries`) on every `pnpm lint`:

```
contracts  <-  packages  <-  services  <-  apps
```

- **Stratifit Media** (public app) may consume public-safe shared contracts and
  authorized public-facing services, but must NEVER import: `@stratifit/compute`,
  `@stratifit/ai`, `@stratifit/workflows`, `@stratifit/database`,
  `@stratifit/storage`, `@stratifit/production-engine` — or anything
  RunPod/ComfyUI/worker-specific.
- **Stratifit Control** may import all packages and services.
- Infrastructure credentials stay server-side. No `NEXT_PUBLIC_` secrets.

## Commands

```bash
pnpm install
pnpm turbo run typecheck lint test build
pnpm --filter @stratifit/database db:generate   # offline migration generation
```

## Status

Foundation only. No real AI generation, no live RunPod calls, no wired Supabase
authentication, and no final domain schema (that follows `DOMAIN_MODEL.md`).
See `docs/` for the (draft, pending-review) product and architecture documents.
