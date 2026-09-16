# Roadmap

> **Bootstrap draft derived from operator architecture brief — pending human review**

## Phase 0 — Foundation (current)

Monorepo scaffold, two applications, shared packages, mechanically enforced
boundaries, CI, bootstrap documentation. No live infrastructure, no real generation.

## Phase 1 — Architecture definition (next)

`DOMAIN_MODEL.md`, then `SERVICE_ARCHITECTURE.md`, `DATA_FLOW.md`,
`EVENT_ARCHITECTURE.md`, `API_ARCHITECTURE.md`. The domain database schema follows
only after DOMAIN_MODEL.md is approved.

## Phase 2 — Platform wiring

Live Supabase authentication (operator + audience), database deployment, storage
wiring, real object storage, auth-gated Control capabilities.

## Phase 3 — Production pipeline

AI Director planning flows, Production Gate enforcement end-to-end, job engine with
queues (BullMQ/Redis), worker runtime, provenance capture, QC tooling.

## Phase 4 — Compute execution

Compute planning and allocation, RunPod provider implementation behind
ComputeProvider, ComfyUI workflow runtime behind the workflow abstraction, GPU
workers for image/video/audio/music.

## Phase 5 — Public platform

Stratifit Media audience experience, publication to Stratifit Media via publishing
engine, AI creator public profiles, social graph (follow/like/comment/share),
notifications.

## Phase 6 — Messaging and leads

Conversation UI, AI Communication Engine, Control Room inbox, human takeover, lead
classification and assignment, email verification enforcement.

## Phase 7 — Editorial, growth, and distribution

CMS, editorial, advertising/campaigns, analytics, recommendations, experimentation,
external publishing adapters (YouTube, TikTok, Instagram, Facebook), live production.
